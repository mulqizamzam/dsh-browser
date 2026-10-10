import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

/**
 * The headless-display regression test.
 *
 * Failure mode guarded: on a system with no X server, the Electron child died
 * with SIGTRAP ("Missing X server or $DISPLAY") before any plugin code ran,
 * and every browser call ended in "browser host exited (signal=SIGTRAP)".
 * The fix starts a per-child Xvfb when (and only when) the environment is a
 * headless Linux one, and passes it to the child as DISPLAY.
 *
 * The spawn test is the proof: with the fix reverted it FAILS (the child dies
 * before the hello, so every command rejects host-gone); with the fix applied
 * it PASSES (the view answers real CDP commands over the virtual display).
 */

// Isolate the host log: this file constructs a real host, which writes spawn
// and exit lines to $DSH_HOME/logs/dsh-builtin-browser-host.log — the log an
// operator reads to diagnose a crash loop. Synthetic entries would make its
// history unreadable. Module scope, set before the dynamic import below.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-headless-'))

const { RemoteElectronViewHost, defaultHostMainPath } = await import('../lib/browser-electron/remote-host.js')
const { needsVirtualDisplay, pickDisplayNumber, findXvfbBinary, takenDisplayNumbers } = await import('../lib/browser-electron/headless-display.js')

test('the headless decision is exactly "Linux with no display at all"', () => {
  assert.equal(needsVirtualDisplay('linux', undefined, undefined), true)
  assert.equal(needsVirtualDisplay('linux', '', undefined), true, 'DISPLAY= (empty) is the same headless machine')
  assert.equal(needsVirtualDisplay('linux', '   ', undefined), true, 'whitespace DISPLAY counts as unset')
  assert.equal(needsVirtualDisplay('linux', ':0', undefined), false)
  assert.equal(needsVirtualDisplay('linux', undefined, 'wayland-0'), false, 'a Wayland compositor is a display')
  assert.equal(needsVirtualDisplay('darwin', undefined, undefined), false, 'macOS always has a display server')
  assert.equal(needsVirtualDisplay('win32', undefined, undefined), false, 'Windows always has a display server')
})

test('the display-number picker never steals a taken display', () => {
  assert.equal(pickDisplayNumber([]), 90)
  assert.equal(pickDisplayNumber([90]), 91)
  assert.equal(pickDisplayNumber([90, 91, 92]), 93)
  assert.equal(pickDisplayNumber([89]), 90, 'a taken display below the range is irrelevant')
  assert.equal(pickDisplayNumber(Array.from({ length: 110 }, (_, i) => 90 + i)), undefined, 'all taken')
})

test('Xvfb is found on PATH, PATH order first', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-xvfb-'))
  const fake = join(dir, 'Xvfb')
  writeFileSync(fake, '#!/bin/sh\n')
  chmodSync(fake, 0o755)
  // The crafted entry comes first; a later bogus entry must not matter.
  assert.equal(findXvfbBinary(`${dir}${delimiter}/nonexistent`), fake, 'a PATH hit must win')
  const onSystem = findXvfbBinary(process.env.PATH)
  if (onSystem !== undefined) {
    assert.match(onSystem, /Xvfb$/)
  }
})

/**
 * The proof test: the real child, on this machine's real filesystem, with the
 * display variables REMOVED — the exact environment the crash happened in.
 */
test(
  'a headless spawn answers CDP commands through a virtual display',
  { timeout: 180_000 },
  async () => {
    const xvfb = findXvfbBinary(process.env.PATH)
    if (process.platform !== 'linux' || xvfb === undefined) {
      // The fix is Linux-only and Xvfb is its environment prerequisite, so the
      // spawn proof can only run where both hold. It runs on the machine the
      // regression was reported on; skipping elsewhere is a platform fact,
      // not a weakened test.
      console.log(`skip: platform=${process.platform} xvfb=${String(xvfb)}`)
      return
    }
    const savedDisplay = process.env.DISPLAY
    const savedWayland = process.env.WAYLAND_DISPLAY
    delete process.env.DISPLAY
    delete process.env.WAYLAND_DISPLAY
    const host = new RemoteElectronViewHost(defaultHostMainPath())
    try {
      const view = host.createView()
      // Without the fix this rejects: the child dies with SIGTRAP before the
      // hello, every command is host-gone, and the recovery retry fails too.
      const evaluated = await view.sendCommand('Runtime.evaluate', { expression: '1+1' })
      assert.equal(evaluated?.result?.value, 2, `unexpected evaluate reply: ${JSON.stringify(evaluated)}`)

      // A second, page-level command proves the view really rendered — the
      // display surface exists and the debugger is attached to it.
      await view.sendCommand('Page.navigate', { url: 'about:blank' })
      const title = await view.sendCommand('Runtime.evaluate', { expression: 'document.title' })
      assert.equal(title?.result?.value, '', `unexpected title reply: ${JSON.stringify(title)}`)

      // The screenshot path is the one that needs a live display surface: it
      // captures the view's framebuffer, which only exists on a running X
      // server. Without a display the child is gone long before this runs.
      const shot = await view.capture()
      assert.match(String(shot.mime), /^image\//)
      assert.ok(String(shot.base64).length > 1000, 'screenshot payload is implausibly small')
    } finally {
      delete process.env.DISPLAY
      delete process.env.WAYLAND_DISPLAY
      if (savedDisplay !== undefined) process.env.DISPLAY = savedDisplay
      if (savedWayland !== undefined) process.env.WAYLAND_DISPLAY = savedWayland
      host.dispose()
    }
  },
)

/**
 * The leak guard: a child that fails to SPAWN never emits 'exit', so its
 * display must die on the 'error' path. Without that, every failed attempt in
 * a restart loop leaves one Xvfb behind — a slow resource leak that looks
 * exactly like the crash loop this fix exists to end.
 */
test(
  'a failed spawn does not leak its virtual display',
  { timeout: 120_000 },
  async () => {
    const xvfb = findXvfbBinary(process.env.PATH)
    if (process.platform !== 'linux' || xvfb === undefined) {
      console.log(`skip: platform=${process.platform} xvfb=${String(xvfb)}`)
      return
    }
    const before = takenDisplayNumbers(join(tmpdir(), '.X11-unix'), tmpdir())
    const savedDisplay = process.env.DISPLAY
    const savedWayland = process.env.WAYLAND_DISPLAY
    delete process.env.DISPLAY
    delete process.env.WAYLAND_DISPLAY
    // A path no binary will ever exist at: the spawn itself fails.
    const host = new RemoteElectronViewHost(defaultHostMainPath(), join(tmpdir(), 'dsh-no-such-electron'))
    try {
      const view = host.createView()
      await assert.rejects(() => view.sendCommand('Runtime.evaluate', { expression: '1' }))
    } finally {
      if (savedDisplay !== undefined) process.env.DISPLAY = savedDisplay
      if (savedWayland !== undefined) process.env.WAYLAND_DISPLAY = savedWayland
      host.dispose()
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
    const leaked = takenDisplayNumbers(join(tmpdir(), '.X11-unix'), tmpdir()).filter(n => n >= 90 && n <= 199 && !before.includes(n))
    assert.deepEqual(leaked, [], `virtual displays leaked by a failed spawn: ${leaked.join(',')}`)
  },
)
