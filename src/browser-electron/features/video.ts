/**
 * Record the active tab as a video file.
 *
 * CONTRACT (implemented in this file)
 *  - `action: 'start'` subscribes the `Page` domain (`deps.subscribe(viewId, ['Page'])`) and
 *    issues `Page.startScreencast` with the requested format/quality/size. Every
 *    `Page.screencastFrame` is acknowledged IMMEDIATELY with `Page.screencastFrameAck` (CDP
 *    stops sending frames until it is acked) and its JPEG/PNG bytes are buffered with a
 *    timestamp. The listener runs on the socket's data path: it may not await, so the ack is
 *    fired without blocking and failures are counted, not thrown.
 *  - `action: 'stop'` issues `Page.stopScreencast`, unsubscribes nothing (the domain set is
 *    the provider's business), asks `deps.ffmpegPath()` for an encoder and writes the frames
 *    to `request.savePath` (required, admitted with `deps.admit(..., 'video')`).
 *  - Encoding: frames are piped to ffmpeg (`-f image2pipe -framerate <captured> -i - -c:v
 *    libx264 -pix_fmt yuv420p -r <fps>`) through `spawn`, stdin closed after the last frame.
 *    No ffmpeg → a clear `BROWSER_VIDEO_NO_FFMPEG` error that names the fact; the frames are
 *    still discarded, never silently reported as a recording.
 *  - Caps: at most `maxFrames` (default 600) buffered frames and 512 MiB of frame bytes; past
 *    either, further frames are dropped and counted as `droppedFrames`. A `stop` with no
 *    recording in flight is `BROWSER_VIDEO_NOT_STARTED`.
 *
 * Notes on choices this file makes (the contract leaves them open):
 *  - The listener is attached BEFORE `Page.startScreencast` is sent. Frames start arriving the
 *    moment that command lands, so a listener attached afterwards loses the head of the take.
 *  - A `stop` that fails after admission has already torn the screencast down: the buffer is
 *    single-use, because a recording that could not be encoded is not a recording, and holding
 *    up to half a gigabyte per view for a retry that can never be encoded is a leak.
 *  - The encoder is resolved BEFORE the buffered frames are counted. No ffmpeg is a machine
 *    fact the operator has to fix either way, and it is the failure the contract singles out;
 *    with frames captured but no encoder there is no file to write under any circumstance.
 *  - A non-zero ffmpeg exit removes the partial file it left behind. `admit` guarantees the
 *    path was free, so whatever is there is ours, and a truncated .mp4 that a caller might
 *    later play is worse than no file at all.
 *
 * @module dsh-builtin-browser/browser-electron/features/video
 */

import { spawn } from 'node:child_process'
import { statSync, unlinkSync } from 'node:fs'

import { BrowserError } from '../../browser/types.js'
import type { BrowserVideoRequest, BrowserVideoResult } from '../../browser/types.js'
import { asNumber, asString, type FeatureDeps } from './deps.js'

/** Chromium's screencast quality when the caller does not name one. */
const DEFAULT_QUALITY = 70

/** Encoder output rate when the caller does not name one. */
const DEFAULT_FPS = 10

/** Buffered frames per view when the caller does not name a cap. */
const DEFAULT_MAX_FRAMES = 600

/**
 * Total buffered frame bytes per view. The frames sit in the DSH process until the take ends,
 * so an unbounded buffer is an out-of-memory waiting for a long recording of a busy page.
 */
const MAX_BUFFER_BYTES = 512 * 1024 * 1024

/**
 * Ceiling on the input rate handed to ffmpeg. Frame timestamps are wall-clock, and a burst of
 * frames inside one millisecond would otherwise read as a rate in the thousands — ffmpeg would
 * then stretch a two-second take into minutes of video.
 */
const MAX_CAPTURED_FPS = 240

/** Screencast start/stop are control calls: they answer quickly or the view is in trouble. */
const CDP_TIMEOUT_MS = 15_000

/** Encoding is local work over an already-captured buffer, but a huge take is still slow. */
const ENCODE_TIMEOUT_MS = 120_000

/** How much of ffmpeg's stderr travels in the error message. Enough to name the cause. */
const STDERR_TAIL_CHARS = 2048

/** One buffered screencast frame. */
interface CapturedFrame {
  /** Epoch milliseconds when the frame was acknowledged. */
  readonly at: number
  /** The decoded image bytes, ready to pipe. Base64 is only a transport encoding. */
  readonly data: Buffer
}

/** The in-flight recording of one view. */
interface Recording {
  /** Frames retained so far, oldest first. */
  readonly frames: CapturedFrame[]
  /** Frame cap for this take. */
  readonly maxFrames: number
  /** Requested output rate, used to place frames when the capture rate is unknowable. */
  readonly fps: number
  /** Epoch milliseconds when the take began. */
  readonly startedAt: number
  /** Detach the event listener. Idempotent. */
  unsubscribe: () => void
  /** Bytes currently held in {@link frames}, tracked so the cap costs no summation. */
  bytes: number
  /** Frames discarded because a cap was reached. */
  dropped: number
  /** Acks that could not be delivered; CDP withholds frames after one, so this explains a stall. */
  ackFailures: number
  /** Epoch milliseconds of the newest retained frame; 0 before the first one. */
  lastAt: number
  /** Set by `stop` (or a replacing `start`) so a frame already on the socket's path is ignored. */
  stopped: boolean
}

/**
 * Per-view recording state, module-level because the provider builds a fresh `FeatureDeps` for
 * every call: a `start` and the `stop` that ends it are two different objects, and only the
 * view id ties them together.
 */
const recordings = new Map<string, Recording>()

/**
 * Read a positive integer out of a request field, falling back when it is absent or nonsense.
 * @param value - the caller's field.
 * @param fallback - the default for a missing or unusable value.
 * @returns a usable positive integer.
 */
function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : fallback
}

/**
 * Start or stop a screen recording of the view behind `viewId`.
 * @param deps - the provider primitives.
 * @param viewId - the backing view of the session's active tab.
 * @param request - `start` or `stop`, plus encoding options.
 * @returns whether a recording is now active, and for a stop the written path and frame count.
 */
export async function controlVideo(deps: FeatureDeps, viewId: string, request: BrowserVideoRequest): Promise<BrowserVideoResult> {
  return request.action === 'start' ? await start(deps, viewId, request) : await stop(deps, viewId, request)
}

/**
 * Begin a take: subscribe `Page`, buffer every frame, ack each one immediately.
 * @param deps - the provider primitives.
 * @param viewId - the view to record.
 * @param request - quality and frame-size options.
 * @returns `{ recording: true }`.
 */
async function start(deps: FeatureDeps, viewId: string, request: BrowserVideoRequest): Promise<BrowserVideoResult> {
  // A second start replaces the first. There is no error code for it in the contract, and
  // leaving the first take alive would mean two listeners acking the same frames and one stop
  // encoding the same buffer twice.
  const stale = recordings.get(viewId)
  if (stale !== undefined) await discard(deps, viewId, stale)

  await deps.subscribe(viewId, ['Page'])

  const recording: Recording = {
    frames: [],
    maxFrames: positiveInteger(request.maxFrames, DEFAULT_MAX_FRAMES),
    fps: positiveInteger(request.fps, DEFAULT_FPS),
    startedAt: Date.now(),
    unsubscribe: () => {},
    bytes: 0,
    dropped: 0,
    ackFailures: 0,
    lastAt: 0,
    stopped: false,
  }

  // The ack comes first and is never awaited. This runs on the socket's data path, where
  // blocking would stall every other CDP event, and CDP already withholds further frames until
  // this one is acknowledged. A failure is counted rather than thrown into the dispatcher.
  const listener = (method: string, params: Record<string, unknown>): void => {
    if (method !== 'Page.screencastFrame' || recording.stopped) return
    try {
      const sessionId = asNumber(params.sessionId)
      void Promise.resolve(deps.send(viewId, 'Page.screencastFrameAck', { sessionId }))
        .catch(() => { recording.ackFailures += 1 })
    } catch {
      recording.ackFailures += 1
    }

    const data = asString(params.data)
    if (data === undefined || data === '') return
    const frame = Buffer.from(data, 'base64')
    if (recording.frames.length >= recording.maxFrames || recording.bytes + frame.byteLength > MAX_BUFFER_BYTES) {
      recording.dropped += 1
      return
    }
    const at = Date.now()
    recording.frames.push({ at, data: frame })
    recording.bytes += frame.byteLength
    recording.lastAt = at
  }

  // Attached before the command that starts the flow, so no frame can arrive unheard.
  recording.unsubscribe = deps.onEvent(viewId, listener)
  recordings.set(viewId, recording)

  const params: Record<string, unknown> = {
    format: 'jpeg',
    quality: positiveInteger(request.quality, DEFAULT_QUALITY),
    everyNthFrame: 1,
    ...request.maxWidth !== undefined ? { maxWidth: request.maxWidth } : {},
    ...request.maxHeight !== undefined ? { maxHeight: request.maxHeight } : {},
  }
  try {
    await deps.send(viewId, 'Page.startScreencast', params, CDP_TIMEOUT_MS)
  } catch (error) {
    recording.stopped = true
    recording.unsubscribe()
    recordings.delete(viewId)
    throw new BrowserError(`browser: starting the screen recording failed: ${String(error)}`, 'BROWSER_VIDEO_START_FAILED', { cause: error })
  }
  return { recording: true }
}

/**
 * End a take: stop the screencast, then encode the buffered frames to `request.savePath`.
 * @param deps - the provider primitives.
 * @param viewId - the view being recorded.
 * @param request - carries the required `savePath`.
 * @returns the written path, its size, and what the take kept and dropped.
 */
async function stop(deps: FeatureDeps, viewId: string, request: BrowserVideoRequest): Promise<BrowserVideoResult> {
  const recording = recordings.get(viewId)
  if (recording === undefined) {
    throw new BrowserError(
      `browser: no video recording is in flight for view ${viewId}; start one before stopping it`,
      'BROWSER_VIDEO_NOT_STARTED',
    )
  }
  // Single-use from here on: every exit below discards the buffer. A stop that cannot encode
  // must not leave a recording that keeps acking and buffering frames nobody will ever read.
  recordings.delete(viewId)

  const savePath = request.savePath
  if (savePath === undefined || savePath === '') {
    await discard(deps, viewId, recording)
    throw new BrowserError('browser: stopping a video recording needs a savePath to write the file to', 'BROWSER_VIDEO_NO_PATH')
  }

  let target: string
  try {
    // Admitted before any CDP work, like every other file the browser writes: a refused path is
    // the caller's to fix, and it must not cost a screencast round-trip.
    target = deps.admit(savePath, 'video')
  } catch (error) {
    // The path was refused, but the screencast must not keep streaming into a dropped buffer.
    await discard(deps, viewId, recording)
    throw error
  }
  await discard(deps, viewId, recording)

  const frames = recording.frames
  const durationMs = Math.max(0, recording.lastAt - recording.startedAt)

  let encoder: string | undefined
  try {
    encoder = await deps.ffmpegPath()
  } catch {
    // A probe that throws is the same fact as a probe that finds nothing.
    encoder = undefined
  }
  if (encoder === undefined || encoder === '') {
    throw new BrowserError(
      'browser: no ffmpeg was found, so the screen recording cannot be encoded; install ffmpeg or set DSH_BROWSER_FFMPEG_PATH. The captured frames are discarded.',
      'BROWSER_VIDEO_NO_FFMPEG',
    )
  }

  if (frames.length === 0) {
    const acks = recording.ackFailures > 0 ? ` (${String(recording.ackFailures)} frame acknowledgements failed, which stalls CDP)` : ''
    throw new BrowserError(`browser: the screen recording captured no frames${acks}`, 'BROWSER_VIDEO_NO_FRAMES')
  }

  const args = [
    '-y',
    '-f', 'image2pipe',
    '-framerate', String(captureRate(frames, recording.fps)),
    // `-vcodec mjpeg` is not decoration: without it ffmpeg has to identify the input codec by
    // probing, and the mjpeg probe only scores maximum when a JPEG's EOI is the LAST byte of
    // the probe buffer. Two concatenated frames defeat it — "Could not find codec parameters
    // for stream 0 (Video: none, none): unknown codec" and exit 234 with no file at all, which
    // is every recording longer than one frame. Naming the decoder skips the probe.
    // `startScreencast` is always asked for `format: 'jpeg'`, so this is the codec that arrives.
    '-vcodec', 'mjpeg',
    '-i', '-',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-r', String(recording.fps),
    target,
  ]
  await encode(encoder, args, frames, target)

  let bytes: number
  try {
    bytes = statSync(target).size
  } catch (error) {
    throw new BrowserError(`browser: ffmpeg reported success but wrote no file at "${target}"`, 'BROWSER_VIDEO_ENCODE_FAILED', { cause: error })
  }
  if (bytes === 0) {
    removePartial(target)
    throw new BrowserError(`browser: ffmpeg reported success but wrote an empty file at "${target}"`, 'BROWSER_VIDEO_ENCODE_FAILED')
  }

  return { recording: false, path: target, bytes, frames: frames.length, droppedFrames: recording.dropped, durationMs }
}

/**
 * Stop the CDP screencast and detach the listener. Best effort by design: the buffer is
 * dropped either way, and a view that is already gone must not turn a stop into a different
 * error than the one the caller needs to see.
 * @param deps - the provider primitives.
 * @param viewId - the view being recorded.
 * @param recording - the state to retire.
 */
async function discard(deps: FeatureDeps, viewId: string, recording: Recording): Promise<void> {
  recording.stopped = true
  recording.unsubscribe()
  try {
    await deps.send(viewId, 'Page.stopScreencast', {}, CDP_TIMEOUT_MS)
  } catch {
    // The view may already be closed; nothing downstream depends on this succeeding.
  }
}

/**
 * The rate the frames actually arrived at, which is the input rate `image2pipe` needs.
 * @param frames - the buffered frames, oldest first.
 * @param fallback - the output rate, for a take too short to measure.
 * @returns a rate in frames per second.
 */
function captureRate(frames: readonly CapturedFrame[], fallback: number): number {
  if (frames.length < 2) return fallback
  const span = frames[frames.length - 1].at - frames[0].at
  if (span <= 0) return fallback
  const rate = (frames.length / span) * 1000
  return Math.min(MAX_CAPTURED_FPS, Math.max(1, Math.round(rate * 1000) / 1000))
}

/**
 * Pipe the frames through ffmpeg and resolve when it exits cleanly.
 * @param encoder - the ffmpeg executable.
 * @param args - its full argument list, output path last.
 * @param frames - the frames, in capture order.
 * @param target - the output path, for removing a partial file on failure.
 * @returns a promise that resolves on exit code 0 and rejects with the stderr tail otherwise.
 */
function encode(encoder: string, args: readonly string[], frames: readonly CapturedFrame[], target: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let stderrTail = ''
    let settled = false
    let timer: NodeJS.Timeout | undefined

    const child = spawn(encoder, args, { stdio: ['pipe', 'ignore', 'pipe'] })

    /** Settle once, either way, and never leave a partial file behind a failure. */
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      if (timer !== undefined) clearTimeout(timer)
      if (error === undefined) {
        resolve()
        return
      }
      removePartial(target)
      reject(error)
    }

    timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        // Already gone.
      }
      finish(new BrowserError(`browser: ffmpeg did not finish within ${String(ENCODE_TIMEOUT_MS)}ms`, 'BROWSER_VIDEO_ENCODE_FAILED'))
    }, ENCODE_TIMEOUT_MS)
    timer.unref()

    child.on('error', error => {
      finish(new BrowserError(`browser: running the video encoder "${encoder}" failed: ${error.message}`, 'BROWSER_VIDEO_ENCODE_FAILED', { cause: error }))
    })
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderrTail = (stderrTail + String(chunk)).slice(-STDERR_TAIL_CHARS)
    })
    child.on('exit', (code, signal) => {
      if (code === 0) {
        finish()
        return
      }
      const how = code === null ? `signal ${String(signal)}` : `code ${String(code)}`
      finish(new BrowserError(`browser: ffmpeg exited with ${how}: ${stderrTail.trim() === '' ? 'no stderr output' : stderrTail.trim()}`, 'BROWSER_VIDEO_ENCODE_FAILED'))
    })

    const stdin = child.stdin
    if (stdin === null) {
      finish(new BrowserError('browser: the video encoder has no stdin to write frames to', 'BROWSER_VIDEO_ENCODE_FAILED'))
      return
    }
    // Without this, an encoder that dies mid-write turns its EPIPE into an uncaught exception
    // on the process; the exit handler already holds the error that explains it.
    stdin.on('error', () => {})

    void (async () => {
      // One `exit` listener for the whole take, not one per frame: `drain` never arrives once
      // the encoder is gone, so the write loop waits on whichever comes first.
      let alive = true
      const dead = new Promise<void>(resolveDead => {
        child.once('exit', () => { alive = false; resolveDead() })
      })
      try {
        for (const frame of frames) {
          if (!alive) break
          if (!stdin.write(frame.data)) {
            await Promise.race([
              new Promise<void>(resolveDrain => { stdin.once('drain', resolveDrain) }),
              dead,
            ])
          }
        }
        if (alive) stdin.end()
      } catch (error) {
        finish(new BrowserError(`browser: writing frames to ffmpeg failed: ${String(error)}`, 'BROWSER_VIDEO_ENCODE_FAILED', { cause: error }))
      }
    })()
  })
}

/**
 * Delete a partial output file. `admit` refused an existing path, so a file here can only be
 * what this encode wrote, and a truncated video is not a recording.
 * @param target - the output path.
 */
function removePartial(target: string): void {
  try {
    unlinkSync(target)
  } catch {
    // Never existed, or already gone: both are the state this wants.
  }
}

/**
 * Drop whatever a destroyed view left behind.
 *
 * A recording holds every captured frame in memory until it is stopped, and its listener keeps
 * that closure alive; a view destroyed mid-recording would otherwise hold both until the
 * process exits. The provider calls this when a session or tab goes away.
 * @param viewId - the view that no longer exists.
 */
export function releaseVideoView(viewId: string): void {
  const recording = recordings.get(viewId)
  if (recording === undefined) return
  recordings.delete(viewId)
  recording.unsubscribe()
}
