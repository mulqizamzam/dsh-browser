// Attaching to a browser that is already running, instead of launching one.
//
// The carrier spawns real browsers, so what is asserted here are the DECISIONS: which URL an
// endpoint resolves to, whether a process was started, whether the browser outlived the session,
// and what an endpoint that cannot be reached does. The launcher and the fetch are injected for
// that reason — the same seams the module already offers for its other tests.
//
// One case is end to end anyway, because the repository already has the server for it:
// tests/fixtures/fake-cdp-browser.mjs is a real HTTP + WebSocket CDP endpoint, so an
// `http://host:port` attach is exercised through /json/version, the WebSocket handshake,
// Target.createTarget and a page command, with no browser installed anywhere.
//
// What this file cannot decide, and does not claim to: that a real Chrome or Edge accepts the
// attach. That needs the browser; everything above it is decided here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { cdpEndpointFrom, cdpEndpointUrl, SystemBrowserViewHost } from '../lib/browser-electron/system-browser.js'
import { createFakeBrowser } from './fixtures/fake-cdp-browser.mjs'

/** A launcher that records and refuses: an attached host must never call it at all. */
function refusingLauncher(launches) {
  return () => {
    launches.push('launched')
    throw new Error('an attached host must not launch a browser')
  }
}

/** A fetch stub that records the URLs it was asked for and answers with one body. */
function stubFetch(seen, body) {
  return async url => {
    seen.push(url)
    return { json: async () => body }
  }
}

/**
 * A port nothing is listening on: bound, then released.
 *
 * Chosen over a fixed number because "nothing answers here" has to be true on the machine
 * running the test, and a hardcoded port is only as empty as the last person who used it.
 */
async function closedPort() {
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  return port
}

/** Run a promise and return the error it rejected with, or undefined when it resolved. */
async function failure(promise) {
  return await promise.then(() => undefined, error => error)
}

test('a ws:// endpoint is taken as-is and never probed', async () => {
  // The browser's own webSocketDebuggerUrl is the shortest path to a connection, and the
  // operator may well have copied it out of /json/version by hand. Resolving it again would
  // only add a way to end up somewhere else.
  const seen = []
  const url = 'ws://127.0.0.1:9222/devtools/browser/6f1e0b2a-3c4d'
  const resolved = await cdpEndpointUrl(url, stubFetch(seen, {}))
  assert.equal(resolved, url)
  assert.deepEqual(seen, [], 'a ws:// endpoint needs no http probe')
})

test('an http:// origin becomes the webSocketDebuggerUrl its /json/version reports', async () => {
  const seen = []
  const resolved = await cdpEndpointUrl(
    'http://127.0.0.1:9222',
    stubFetch(seen, { Browser: 'Chrome/141.0.7390.55', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc' }),
  )
  assert.deepEqual(seen, ['http://127.0.0.1:9222/json/version'], 'the probe goes to the origin this port publishes on')
  assert.equal(resolved, 'ws://127.0.0.1:9222/devtools/browser/abc')
})

test('an origin with a path still probes /json/version at the root', async () => {
  // An operator pasting "http://127.0.0.1:9222/json" is naming the same browser, and the
  // debugging protocol lives at the root of the origin rather than under whatever path came
  // along. Without this the probe 404s and reads as "no browser there".
  const seen = []
  const resolved = await cdpEndpointUrl('http://127.0.0.1:9222/json', stubFetch(seen, { webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc' }))
  assert.deepEqual(seen, ['http://127.0.0.1:9222/json/version'])
  assert.equal(resolved, 'ws://127.0.0.1:9222/devtools/browser/abc')
})

test('a malformed endpoint is refused, not guessed at', async () => {
  // Every guess picks a browser the operator did not name, and naming one is the whole point of
  // the setting. The stub throws if it is reached, so a value that skips validation fails here
  // with PROBED in the message instead of quietly being fetched.
  const seen = []
  const probing = async url => {
    seen.push(url)
    throw new Error('PROBED: this value should have been refused before any fetch')
  }
  for (const bad of ['127.0.0.1:9222', 'ftp://127.0.0.1:9222', 'not a url', '']) {
    const error = await failure(cdpEndpointUrl(bad, probing))
    assert.equal(error?.code, 'BROWSER_CDP_ENDPOINT_UNREACHABLE', `refused: ${JSON.stringify(bad)}`)
    assert.doesNotMatch(error.message, /PROBED/, 'refused before touching the network')
    if (bad !== '') assert.ok(error.message.includes(bad), `names the endpoint it tried: ${error.message}`)
  }
  const missing = await failure(cdpEndpointUrl('http://127.0.0.1:9222', stubFetch(seen, { Browser: 'Chrome/141' })))
  assert.equal(missing?.code, 'BROWSER_CDP_ENDPOINT_UNREACHABLE', 'an answer without a ws URL is not an endpoint')
  assert.match(missing.message, /webSocketDebuggerUrl/)
})

test('the config field wins over the environment, and a blank value counts as unset', () => {
  const env = { DSH_BROWSER_CDP_ENDPOINT: 'ws://env:9222/devtools/browser/env' }
  assert.equal(cdpEndpointFrom('ws://config:9222/devtools/browser/config', env), 'ws://config:9222/devtools/browser/config')
  assert.equal(cdpEndpointFrom(undefined, env), 'ws://env:9222/devtools/browser/env')
  assert.equal(cdpEndpointFrom(undefined, {}), undefined, 'nothing configured means launch, as before')
  assert.equal(cdpEndpointFrom('   ', env), 'ws://env:9222/devtools/browser/env', 'blank config falls through to the environment')
  assert.equal(cdpEndpointFrom(undefined, { DSH_BROWSER_CDP_ENDPOINT: '' }), undefined, 'an empty variable is not an endpoint')
  assert.equal(cdpEndpointFrom('  ws://127.0.0.1:9222/devtools/browser/a  ', {}), 'ws://127.0.0.1:9222/devtools/browser/a', 'surrounding space is not part of the URL')
})

test('an attached host launches nothing and drives the browser it was pointed at', async () => {
  // End to end over the fixture: the endpoint is an http origin, so this goes through
  // /json/version, the WebSocket handshake and the CDP session — the whole attach path.
  const browser = createFakeBrowser()
  const port = await browser.listen()
  const launches = []
  const host = SystemBrowserViewHost.attach(`http://127.0.0.1:${port}`, refusingLauncher(launches))
  try {
    assert.equal(host.ownsBrowser, false, 'the browser belongs to whoever started it, not to this host')
    await host.createView().sendCommand('Runtime.evaluate', { expression: '1' })
    assert.deepEqual(launches, [], 'the launcher double was never called')
    assert.equal(host.started, false, 'and no process was started')
    assert.match(String(browser.sessionId), /^session-/, 'the page came from the attached browser')
  } finally {
    host.dispose()
    await browser.kill()
  }
})

test('releasing an attached host leaves that browser running', async () => {
  // The half that matters. A browser the operator started is theirs — quite possibly with their
  // own windows in it — so closing our session may end our connection and nothing else. The
  // kill double is the observable: the fixture's own kill, wrapped and counted.
  const browser = createFakeBrowser()
  const port = await browser.listen()
  const realKill = browser.kill.bind(browser)
  let kills = 0
  browser.kill = async () => {
    kills += 1
    return await realKill()
  }

  const host = SystemBrowserViewHost.attach(`http://127.0.0.1:${port}`)
  const view = host.createView()
  try {
    await view.sendCommand('Runtime.evaluate', { expression: '1' })
    // Closing the page we opened, then releasing the host: both are teardown, neither is a kill.
    host.destroyView(view)
    host.dispose()
    assert.equal(kills, 0, 'the attached browser was never killed')
    assert.equal(host.ownsBrowser, false)

    // And it is genuinely still up, not merely unkilled: its debugging endpoint still answers.
    const version = await fetch(`http://127.0.0.1:${port}/json/version`)
    assert.equal(version.status, 200, 'the browser this session attached to is still listening')
  } finally {
    await realKill()
  }
})

test('an unreachable endpoint fails by name and launches nothing instead', async () => {
  // The fallback is the failure mode this test exists for: bringing up a different browser than
  // the operator named would look like success and drive the wrong machine's pages.
  const launches = []
  const host = SystemBrowserViewHost.attach('http://127.0.0.1:9', refusingLauncher(launches), async () => {
    throw new Error('connect ECONNREFUSED 127.0.0.1:9')
  })
  const error = await failure(host.createView().sendCommand('Runtime.evaluate', { expression: '1' }))
  assert.equal(error?.code, 'BROWSER_CDP_ENDPOINT_UNREACHABLE')
  assert.ok(error.message.includes('127.0.0.1:9'), `names the endpoint it tried: ${error.message}`)
  assert.deepEqual(launches, [], 'a failed attach never falls back to launching')
})

test('a ws:// endpoint nothing answers on fails by name too', async () => {
  // The other half of "unreachable": the URL was well formed, the browser behind it is not
  // there. The socket's own refusal must not surface as a bare CDP handshake error, and it must
  // not become a launch either.
  const launches = []
  const port = await closedPort()
  const endpoint = `ws://127.0.0.1:${port}/devtools/browser/gone`
  const host = SystemBrowserViewHost.attach(endpoint, refusingLauncher(launches))
  const error = await failure(host.createView().sendCommand('Runtime.evaluate', { expression: '1' }))
  assert.equal(error?.code, 'BROWSER_CDP_ENDPOINT_UNREACHABLE')
  assert.ok(error.message.includes(endpoint), `names the endpoint it tried: ${error.message}`)
  assert.deepEqual(launches, [], 'and still launched nothing')
})

test('an attached browser that goes away is not replaced by a launched one', async () => {
  // The reconnect path, which is where a fallback would be easy to write and hard to notice:
  // the browser the operator was driving closes, the host needs a browser again, and every
  // other carrier here answers that need by starting one. Doing that in attach mode would
  // silently swap the operator's browser for the plugin's own.
  const browser = createFakeBrowser()
  const port = await browser.listen()
  const launches = []
  const host = SystemBrowserViewHost.attach(`http://127.0.0.1:${port}`, refusingLauncher(launches))
  const view = host.createView()
  try {
    await view.sendCommand('Runtime.evaluate', { expression: '1' })
    await browser.kill()
    // The socket's close event is asynchronous; this lets the host see the drop before the call
    // that has to decide what to do about it.
    await new Promise(resolve => setTimeout(resolve, 100))
    // The first call is the one that discovers the connection is gone, so it is allowed to fail
    // for that reason (the restart suite makes the same allowance). What matters is the call
    // after it, which is the one that would have started a replacement.
    await failure(view.sendCommand('Runtime.evaluate', { expression: '2' }))
    const after = await failure(view.sendCommand('Runtime.evaluate', { expression: '3' }))
    assert.equal(after?.code, 'BROWSER_CDP_ENDPOINT_UNREACHABLE', `expected the endpoint to be reported, got: ${after}`)
    assert.ok(after.message.includes(`127.0.0.1:${port}`), 'and to be named')
    assert.deepEqual(launches, [], 'no browser was launched to replace the one that went away')
  } finally {
    host.dispose()
    await browser.kill().catch(() => undefined)
  }
})

test('releasing a host that DID launch its browser still kills it', async () => {
  // The other direction of the same flag, and the reason it is a flag rather than a fact about
  // the code: true must keep meaning "this process is ours to end". Without this half, a flag
  // that was always false would look correct from the attach side and leak a browser here.
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-cdp-owned-'))
  const browser = createFakeBrowser()
  const port = await browser.listen()
  let kills = 0
  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  child.kill = () => {
    kills += 1
    if (child.exitCode !== null) return
    child.exitCode = 0
    queueMicrotask(() => child.emit('exit', 0, null))
  }
  const host = new SystemBrowserViewHost({ kind: 'chrome', path: 'fake-browser' }, profileDir, [], undefined, () => {
    const portFile = join(profileDir, 'DevToolsActivePort')
    writeFileSync(portFile, `${port}\n`)
    // Stamped forward, like the restart suite's launchers: `freshPort()` refuses a file older
    // than the spawn, and CI's timestamp resolution can otherwise decide this test.
    const ahead = new Date(Date.now() + 1000)
    utimesSync(portFile, ahead, ahead)
    return child
  })
  try {
    await host.createView().sendCommand('Runtime.evaluate', { expression: '1' })
    assert.equal(host.ownsBrowser, true)
    host.dispose()
    assert.equal(kills, 1, 'the browser this host started is killed on release')
  } finally {
    host.dispose()
    await browser.kill()
    rmSync(profileDir, { recursive: true, force: true })
  }
})

test('with no endpoint the launch path still runs', async () => {
  // The unchanged case, from the other side: nothing here may turn an ordinary launch into
  // something else. The child is already exited, so the launch ends at once rather than at the
  // 30 s deadline — what is asserted is that the launcher was reached at all.
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-cdp-unset-'))
  const launches = []
  const host = new SystemBrowserViewHost({ kind: 'chrome', path: 'fake-browser' }, profileDir, [], undefined, () => {
    launches.push('launched')
    const child = new EventEmitter()
    child.exitCode = 0
    child.signalCode = null
    child.kill = () => {}
    return child
  })
  try {
    assert.equal(host.ownsBrowser, true, 'a host that launches owns the browser it started')
    const error = await failure(host.createView().sendCommand('Runtime.evaluate', { expression: '1' }))
    assert.equal(launches.length, 1, 'the launcher double was called')
    assert.match(String(error?.message), /exited immediately/, `the launch path reported its own outcome: ${error?.message}`)
  } finally {
    host.dispose()
    rmSync(profileDir, { recursive: true, force: true })
  }
})
