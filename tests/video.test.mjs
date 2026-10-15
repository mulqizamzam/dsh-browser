// browser_video, driven through the feature module that actually talks CDP.
//
// The recorder is the one feature whose interesting half runs on the socket's data path: a
// frame arrives, it must be acked before CDP sends the next one, and the buffer it lands in is
// capped. A fake that only records calls would not show any of that, so `makeHarness()` below
// captures the real listener `onEvent` registers and delivers frames into it — and the tests
// assert on what the listener did BEFORE it returned, which is the non-blocking ack.
//
// Every call gets a fresh deps object, exactly as the provider builds one per call, so a
// recording that only worked because one closure held both halves would fail here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { controlVideo } from '../lib/browser-electron/features/video.js'

/**
 * A 2x2 JPEG, the smallest image libx264 will accept with `-pix_fmt yuv420p`.
 *
 * A 1x1 JPEG cannot be used here: yuv420p subsamples chroma by two, so libx264 refuses odd
 * dimensions — verified against ffmpeg 8.0.1 on this machine, where the 1x1 encode exits 187
 * with "Nothing was written into output file" and leaves a zero-byte file. Two by two is the
 * smallest that really encodes, which is what the encoder test needs.
 *
 * Produced with: ffmpeg -f lavfi -i color=c=red:s=2x2:d=1 -frames:v 1 j.jpg
 */
const TINY_JPEG = '/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjExLjEwMAD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABMAAEBAAAAAAAAAAAAAAAAAAAABgEBAQAAAAAAAAAAAAAAAAAABgcQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAACAAIDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCLAE1/f//Z'

/** A JPEG with dimensions libx264 refuses, to drive a real encoder's failure path. */
const ONE_PIXEL_JPEG = '/9j/4AAQSkZJRgABAgAAAQABAAD//gAQTGF2YzYyLjExLjEwMAD/2wBDAAgEBAQEBAUFBQUFBQYGBgYGBgYGBgYGBgYHBwcICAgHBwcGBgcHCAgICAkJCQgICAgJCQoKCgwMCwsODg4RERT/xABMAAEBAAAAAAAAAAAAAAAAAAAABgEBAQAAAAAAAAAAAAAAAAAABgcQAQAAAAAAAAAAAAAAAAAAAAARAQAAAAAAAAAAAAAAAAAAAAD/wAARCAABAAEDASIAAhEAAxEA/9oADAMBAAIRAxEAPwCLAE1/f//Z'

/** The real encoder, when this machine has one. */
const FFMPEG = '/usr/bin/ffmpeg'

/**
 * A stand-in for ffmpeg: counts the JPEG frames it is piped and writes that count to the output
 * file. It is a sink, not an encoder, so the tests can assert how many frames actually reached
 * the encoder — which is the only way to see the buffer cap from outside the module.
 */
const FAKE_ENCODER_SOURCE = `#!/usr/bin/env node
const { writeFileSync } = require('node:fs')
const chunks = []
process.stdin.on('data', chunk => chunks.push(chunk))
process.stdin.on('end', () => {
  const all = Buffer.concat(chunks)
  let frames = 0
  for (let i = 0; i + 1 < all.length; i += 1) if (all[i] === 0xff && all[i + 1] === 0xd8) frames += 1
  writeFileSync(process.argv[process.argv.length - 1], 'frames=' + frames)
  process.exit(0)
})
`

/**
 * A `FeatureDeps` double for one call, sharing the harness's log and listener set.
 *
 * The log is shared on purpose: `start` and `stop` are two calls with two deps objects, and the
 * ordering assertion ("admitted before any CDP work") is only meaningful across both.
 */
function makeHarness() {
  const log = []
  const listeners = new Set()
  const sends = () => log.filter(entry => entry.what === 'send')
  const acks = () => sends().filter(entry => entry.method === 'Page.screencastFrameAck')

  return {
    log,
    sends,
    acks,
    /** Index of the first logged entry matching `predicate`, or -1. */
    at: predicate => log.findIndex(predicate),
    /** One fresh deps object, as the provider builds for every call. */
    depsFor(options = {}) {
      return {
        send: async (viewId, method, params) => {
          log.push({ what: 'send', viewId, method, params })
          return {}
        },
        subscribe: async (viewId, domains) => { log.push({ what: 'subscribe', viewId, domains }) },
        onEvent: (viewId, listener) => {
          const entry = { viewId, listener }
          listeners.add(entry)
          log.push({ what: 'onEvent' })
          return () => { listeners.delete(entry); log.push({ what: 'off' }) }
        },
        admit: (savePath, kind) => {
          log.push({ what: 'admit', savePath, kind })
          if (options.admit !== undefined) return options.admit(savePath, kind)
          return savePath
        },
        ffmpegPath: async () => { log.push({ what: 'ffmpegPath' }); return options.ffmpeg },
        writeFile: path => { log.push({ what: 'writeFile', path }) },
      }
    },
    /** Deliver a CDP event to whatever listeners are attached right now. */
    deliver(method, params) {
      for (const entry of [...listeners]) entry.listener(method, params)
    },
    /** How many listeners are still attached. */
    attached: () => listeners.size,
  }
}

/** A throwaway directory for one test, removed when it ends. */
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-video-'))
  t.after(() => { rmSync(dir, { recursive: true, force: true }) })
  return dir
}

/** Write the stand-in encoder and return its path. */
function fakeEncoder(dir) {
  const path = join(dir, 'fake-ffmpeg')
  writeFileSync(path, FAKE_ENCODER_SOURCE, { mode: 0o755 })
  chmodSync(path, 0o755)
  return path
}

test('a stop with no recording in flight is refused, not reported as a zero-frame recording', async () => {
  const h = makeHarness()
  await assert.rejects(controlVideo(h.depsFor(), 'view-1', { action: 'stop', savePath: '/tmp/never.mp4' }), error => {
    assert.equal(error.code, 'BROWSER_VIDEO_NOT_STARTED')
    return true
  })
  // Nothing was done to the browser on the way to the refusal: no screencast was stopped, and
  // no path was admitted for a recording that does not exist.
  assert.equal(h.sends().length, 0, 'no CDP traffic')
  assert.equal(h.log.filter(entry => entry.what === 'admit').length, 0, 'no path admitted')
})

test('a stop without savePath is refused and still retires the recording', async () => {
  const h = makeHarness()
  await controlVideo(h.depsFor(), 'view-2', { action: 'start' })
  await assert.rejects(controlVideo(h.depsFor(), 'view-2', { action: 'stop' }), error => {
    assert.equal(error.code, 'BROWSER_VIDEO_NO_PATH')
    return true
  })
  // The screencast was stopped and the listener detached: the buffer is single-use, so a
  // refused stop must not leave CDP streaming frames into something nobody can encode.
  assert.ok(h.sends().some(entry => entry.method === 'Page.stopScreencast'), 'screencast stopped')
  assert.equal(h.attached(), 0, 'listener detached')
  await assert.rejects(controlVideo(h.depsFor(), 'view-2', { action: 'stop', savePath: '/tmp/x.mp4' }), error => {
    assert.equal(error.code, 'BROWSER_VIDEO_NOT_STARTED')
    return true
  })
})

test('no ffmpeg: the stop fails with BROWSER_VIDEO_NO_FFMPEG and no file is claimed or left', async t => {
  const dir = scratch(t)
  const target = join(dir, 'out.mp4')
  const h = makeHarness()
  await controlVideo(h.depsFor(), 'view-3', { action: 'start' })
  h.deliver('Page.screencastFrame', { data: TINY_JPEG, sessionId: 7, metadata: {} })

  await assert.rejects(
    controlVideo(h.depsFor({ ffmpeg: undefined }), 'view-3', { action: 'stop', savePath: target }),
    error => {
      assert.equal(error.code, 'BROWSER_VIDEO_NO_FFMPEG')
      return true
    },
  )
  // "Never report a recording that was not written": the rejection is the whole answer, and no
  // artifact appears at the path.
  assert.equal(existsSync(target), false, 'no file was written')
})

test('start, three frames, stop: every frame is acked before the listener returns and all three are encoded', async t => {
  const dir = scratch(t)
  const target = join(dir, 'take.mp4')
  const h = makeHarness()

  const started = await controlVideo(h.depsFor(), 'view-4', { action: 'start', quality: 55, maxWidth: 640, maxHeight: 480, fps: 12 })
  assert.deepEqual(started, { recording: true })

  const subscribeAt = h.at(entry => entry.what === 'subscribe')
  const startAt = h.at(entry => entry.what === 'send' && entry.method === 'Page.startScreencast')
  assert.ok(subscribeAt >= 0 && startAt > subscribeAt, 'Page is subscribed before the screencast starts')
  assert.deepEqual(h.log[subscribeAt].domains, ['Page'])
  const startParams = h.sends()[0].params
  assert.equal(startParams.format, 'jpeg')
  assert.equal(startParams.quality, 55)
  assert.equal(startParams.maxWidth, 640)
  assert.equal(startParams.maxHeight, 480)
  assert.equal(startParams.everyNthFrame, 1)

  for (let n = 0; n < 3; n += 1) {
    h.deliver('Page.screencastFrame', { data: TINY_JPEG, sessionId: 100 + n, metadata: { timestamp: n } })
    // The listener runs on the socket's data path and may not await: the ack has to have been
    // SENT by the time deliver() returns, or CDP would sit waiting for it.
    assert.equal(h.acks().length, n + 1, `frame ${String(n)} is acked before the listener returns`)
  }
  assert.deepEqual(h.acks().map(entry => entry.params.sessionId), [100, 101, 102], 'each ack carries its own session id')

  const result = await controlVideo(h.depsFor({ ffmpeg: fakeEncoder(dir) }), 'view-4', { action: 'stop', savePath: target })

  const admitAt = h.at(entry => entry.what === 'admit')
  const stopAt = h.at(entry => entry.what === 'send' && entry.method === 'Page.stopScreencast')
  assert.ok(admitAt >= 0, 'the path was admitted')
  assert.equal(h.log[admitAt].kind, 'video', 'admitted as a video path')
  assert.ok(stopAt > admitAt, 'the destination is admitted before any CDP work')
  assert.equal(h.attached(), 0, 'the listener is dropped at stop')

  assert.equal(result.recording, false)
  assert.equal(result.path, target)
  assert.equal(result.frames, 3)
  assert.equal(result.droppedFrames, 0)
  assert.ok(result.bytes > 0, 'the encoder wrote bytes')
  assert.equal(result.bytes, statSync(target).size, 'bytes is the size of the file on disk')
  assert.equal(readFileSync(target, 'utf8'), 'frames=3', 'exactly the three captured frames reached the encoder')
  assert.ok(typeof result.durationMs === 'number' && result.durationMs >= 0, 'a duration is reported')
})

test('a frame cap drops the overflow and says how many frames were dropped', async t => {
  const dir = scratch(t)
  const target = join(dir, 'capped.mp4')
  const h = makeHarness()
  await controlVideo(h.depsFor(), 'view-5', { action: 'start', maxFrames: 4 })

  for (let n = 0; n < 6; n += 1) {
    h.deliver('Page.screencastFrame', { data: TINY_JPEG, sessionId: n, metadata: {} })
  }

  const result = await controlVideo(h.depsFor({ ffmpeg: fakeEncoder(dir) }), 'view-5', { action: 'stop', savePath: target })
  assert.equal(result.droppedFrames, 2, 'the two frames past the cap are counted, not buffered')
  assert.equal(result.frames, 4, 'the buffer is capped at maxFrames')
  assert.equal(readFileSync(target, 'utf8'), 'frames=4', 'and only four frames were piped to the encoder')
  // A dropped frame is still acked: CDP is waiting on the ack, and withholding it would stall
  // the screencast for every frame after the first one past the cap.
  assert.equal(h.acks().length, 6, 'all six frames are acked, dropped or not')
})

test('the frame listener is detached at stop, so a late frame changes nothing', async t => {
  const dir = scratch(t)
  const target = join(dir, 'late.mp4')
  const h = makeHarness()
  await controlVideo(h.depsFor(), 'view-6', { action: 'start' })
  h.deliver('Page.screencastFrame', { data: TINY_JPEG, sessionId: 1, metadata: {} })
  const acksBefore = h.acks().length

  const pending = controlVideo(h.depsFor({ ffmpeg: fakeEncoder(dir) }), 'view-6', { action: 'stop', savePath: target })
  h.deliver('Page.screencastFrame', { data: TINY_JPEG, sessionId: 2, metadata: {} })
  const result = await pending

  assert.equal(result.frames, 1, 'the frame delivered after stop is not encoded')
  assert.equal(h.acks().length, acksBefore, 'and it is not acked either')
})

test('zero frames: the stop names the empty recording instead of writing an empty file', async t => {
  const dir = scratch(t)
  const target = join(dir, 'empty.mp4')
  const h = makeHarness()
  await controlVideo(h.depsFor(), 'view-7', { action: 'start' })

  await assert.rejects(
    controlVideo(h.depsFor({ ffmpeg: fakeEncoder(dir) }), 'view-7', { action: 'stop', savePath: target }),
    error => {
      assert.equal(error.code, 'BROWSER_VIDEO_NO_FRAMES')
      return true
    },
  )
  assert.equal(existsSync(target), false, 'no empty file is left behind')
})

test('a real encoder writes a real, non-empty video from the captured JPEG frames', async t => {
  if (!existsSync(FFMPEG)) {
    t.skip(`${FFMPEG} is not installed on this machine`)
    return
  }
  const dir = scratch(t)
  const target = join(dir, 'real.mp4')
  const h = makeHarness()
  await controlVideo(h.depsFor(), 'view-8', { action: 'start', fps: 10 })
  for (let n = 0; n < 3; n += 1) {
    h.deliver('Page.screencastFrame', { data: TINY_JPEG, sessionId: n, metadata: {} })
  }

  const result = await controlVideo(h.depsFor({ ffmpeg: FFMPEG }), 'view-8', { action: 'stop', savePath: target })

  assert.equal(existsSync(target), true, 'ffmpeg wrote the file')
  const size = statSync(target).size
  assert.ok(size > 0, `the encoded file is non-empty (${String(size)} bytes)`)
  assert.equal(result.bytes, size)
  assert.equal(result.frames, 3)
  assert.equal(result.path, target)
})

test('a real encoder that fails is reported with its stderr, and its partial file is removed', async t => {
  if (!existsSync(FFMPEG)) {
    t.skip(`${FFMPEG} is not installed on this machine`)
    return
  }
  const dir = scratch(t)
  const target = join(dir, 'broken.mp4')
  const h = makeHarness()
  await controlVideo(h.depsFor(), 'view-9', { action: 'start' })
  // 1x1 cannot be encoded as yuv420p, so ffmpeg exits non-zero and leaves a zero-byte file.
  h.deliver('Page.screencastFrame', { data: ONE_PIXEL_JPEG, sessionId: 1, metadata: {} })

  await assert.rejects(
    controlVideo(h.depsFor({ ffmpeg: FFMPEG }), 'view-9', { action: 'stop', savePath: target }),
    error => {
      assert.equal(error.code, 'BROWSER_VIDEO_ENCODE_FAILED')
      assert.match(String(error.message), /ffmpeg exited with code/, 'the exit status is named')
      assert.match(String(error.message), /libx264|Invalid argument|Nothing was written/, 'stderr travels with the error')
      return true
    },
  )
  assert.equal(existsSync(target), false, 'the truncated output is not left as a playable artifact')
})
