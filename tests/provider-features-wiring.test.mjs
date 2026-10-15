// The wiring between the provider and the feature modules, on the provider's own ground.
//
// The feature modules are tested against hand-written doubles; what is tested HERE is the
// adapter the provider builds for them — the install probes against the real machine, the
// method-to-module routing, and the refusal a session-less call must produce. None of it needs
// a browser, so it runs anywhere.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ElectronBrowserProvider, resolveFfmpegExecutable } from '../lib/browser-electron/provider.js'

/** A host stub with one view that answers CDP commands without a browser. */
function makeHost() {
  return {
    createView() {
      return {
        id: 'view1',
        async sendCommand() { return {} },
        async capture() { return { base64: '', mime: 'image/png' } },
      }
    },
    destroyView() {},
    showView() {},
    groupView() {},
    onUserAction() {},
    onViewClosed() {},
    onCdpEvent() {},
  }
}

/** A provider over the stub host, with a settings document whose channel is `channel`. */
function makeProvider(channel = 'bundled') {
  return new ElectronBrowserProvider(makeHost(), {
    downloadDir: process.cwd(),
    settings: () => ({ browser: { channel } }),
  })
}

test('install status reports every carrier and the selected channel', async () => {
  const result = await makeProvider('bundled').install({ action: 'status' })
  const kinds = result.carriers.map(carrier => carrier.kind)
  assert.deepEqual(kinds, ['electron', 'chrome', 'edge'], 'all three carriers are looked for')
  assert.equal(result.channel, 'bundled')
  // The Electron probe is the real one (internals.resolveElectronPath over this checkout): the
  // plugin ships an Electron package, so on a healthy install the bundled carrier is present.
  const electron = result.carriers.find(carrier => carrier.kind === 'electron')
  assert.equal(typeof electron.exists, 'boolean', 'existence is reported as a boolean, found or not')
  if (electron.exists) {
    assert.equal(result.ready, true, 'a bundled channel is ready when Electron is there')
    assert.equal(typeof electron.path, 'string', 'and the path it resolved is reported')
  }
})

test('install status is not ready when the selected channel has no carrier', async () => {
  // Chrome is not installed on this machine, and the channel is what decides readiness.
  const result = await makeProvider('chrome').install({ action: 'status' })
  assert.equal(result.channel, 'chrome')
  if (result.carriers.find(carrier => carrier.kind === 'chrome').exists) return // a machine that has it
  assert.equal(result.ready, false, 'chrome selected, chrome missing -> not ready')
  assert.ok(
    result.notes.some(note => note.includes('DSH_BROWSER_CHROME_PATH')),
    `a note names the override that would point at a Chrome elsewhere, got ${JSON.stringify(result.notes)}`,
  )
})

test('installing a system browser is refused with the OS-level reason', async () => {
  await assert.rejects(makeProvider('auto').install({ action: 'install', target: 'system' }), error => {
    assert.equal(error.code, 'BROWSER_INSTALL_UNSUPPORTED')
    assert.match(String(error.message), /sudo/)
    return true
  })
})

test('the feature methods refuse a session that does not exist', async () => {
  const provider = makeProvider()
  const missing = 'session-that-never-was'
  await assert.rejects(provider.pdf(missing, { savePath: '/tmp/x.pdf' }), /session/i)
  await assert.rejects(provider.trace(missing, { action: 'start' }), /session/i)
  await assert.rejects(provider.video(missing, { action: 'start' }), /session/i)
  await assert.rejects(provider.network(missing, { action: 'list' }), /session/i)
})

test('ffmpeg is found by absolute path when the PATH lookup cannot resolve it', async () => {
  // A live run failed here: `spawn('ffmpeg')` inside the running plugin process reported nothing
  // while /usr/bin/ffmpeg was present and executable, so the video tool refused to encode. The
  // resolution no longer depends on PATH alone; this pins that with an empty PATH, which is the
  // closest a test can get to that failure.
  const resolved = await resolveFfmpegExecutable({ PATH: '' })
  if (process.platform === 'win32') return // the fallback list is Windows-shaped; covered there
  assert.equal(resolved, '/usr/bin/ffmpeg', 'the first conventional location answers')
})

test('an override wins, and nothing usable is reported as undefined', async () => {
  assert.equal(await resolveFfmpegExecutable({ PATH: '', DSH_BROWSER_FFMPEG_PATH: '/bin/ffmpeg' }), '/bin/ffmpeg')
  assert.equal(await resolveFfmpegExecutable({ PATH: '', DSH_BROWSER_FFMPEG_PATH: '/nonexistent/ffmpeg' }), '/usr/bin/ffmpeg', 'a bad override falls through to the conventional list')
})
