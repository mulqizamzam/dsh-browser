// The CDP event channel and the supervisor's failure accounting.
//
// Three separate promises are pinned here, all of them observed through the real parent
// (RemoteElectronViewHost) talking to a plain-Node child that speaks the same RPC protocol as
// host-main.js — no Electron, no display:
//
//   1. an unsolicited `cdpEvent` frame from the child reaches the handler for its view;
//   2. a child that announces `hostStopping` before it quits is NOT reported as a failed start
//      (the defect that made an ordinary end of session read as "start failed (attempt 1)");
//   3. one failed start produces exactly ONE failure line, however far apart its two reports
//      are, and the line names the real cause instead of a fixed "the process exited".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { internals, RemoteElectronViewHost } from '../lib/browser-electron/remote-host.js'

// Module scope on purpose, not a `before()` hook: the host reads DSH_HOME when it writes, and
// a hook that runs after the first test body would already be too late. Without isolation the
// synthetic records below land in the operator's real host log.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-event-channel-'))

// The children here are plain Node and need no display at all. Without this the host would
// start an Xvfb per spawn on a headless system, and headless-display.test.mjs — which asserts
// machine-wide that a failed spawn leaks no virtual display — runs in a parallel file and sees
// those displays as leaks. A bogus DISPLAY keeps this file from touching the display pool.
process.env.DISPLAY = ':77'

const LOG = join(process.env.DSH_HOME, 'logs', 'dsh-builtin-browser-host.log')
const fixture = fileURLToPath(new URL('./fixtures/protocol-child.mjs', import.meta.url))
const wait = ms => new Promise(resolve => setTimeout(resolve, ms))

/** Everything appended to the host log since `from`. */
function logSince(from) {
  return existsSync(LOG) ? readFileSync(LOG, 'utf8').slice(from) : ''
}

/** How many bytes the host log currently holds, for taking a slice later. */
function logLength() {
  return existsSync(LOG) ? readFileSync(LOG, 'utf8').length : 0
}

test('a forwarded CDP event reaches the host handler for the subscribed view', async () => {
  process.env.PROTOCOL_CHILD_MODE = 'normal'
  const host = new RemoteElectronViewHost(fixture, process.execPath)
  const seen = []
  host.onCdpEvent(event => seen.push(event))
  const view = host.createView()
  try {
    await view.subscribe(['Network'])
    await view.sendCommand('__emit')
    await wait(80)
    assert.equal(seen.length, 1, 'exactly one event was forwarded')
    assert.equal(seen[0].method, 'Network.responseReceived', 'the CDP method travels verbatim')
    assert.equal(seen[0].viewId, view.id, 'the event is attributed to the view that emitted it')
    assert.deepEqual(seen[0].params, { requestId: 'r1', response: { status: 200 } }, 'the payload is untouched')
  } finally {
    host.dispose()
  }
})

test('a deliberate shutdown is not reported as a failed start', async () => {
  process.env.PROTOCOL_CHILD_MODE = 'normal'
  const host = new RemoteElectronViewHost(fixture, process.execPath)
  const view = host.createView()
  try {
    // Materialize first: the point is a host that came up, then ended on purpose.
    await view.sendCommand('noop')
    const before = logLength()
    await view.sendCommand('__stop')
    await wait(700)
    const tail = logSince(before)
    assert.match(tail, /browser host exited \(code=0/, 'the clean exit is still recorded')
    assert.doesNotMatch(tail, /browser host start failed/, 'an ordinary end of session is not a failed start')
  } finally {
    host.dispose()
  }
})

test('a refused authentication is logged as that, not as "the process exited"', async () => {
  process.env.PROTOCOL_CHILD_MODE = 'badtoken'
  const host = new RemoteElectronViewHost(fixture, process.execPath)
  const view = host.createView()
  try {
    const before = logLength()
    await assert.rejects(view.sendCommand('noop'), /authenticat/i)
    await wait(400)
    const tail = logSince(before)
    assert.match(tail, /authentication failed/i, 'the real cause is what the operator reads')
    assert.doesNotMatch(tail, /the browser host process exited/, 'the fixed sentence that used to hide every cause')
  } finally {
    host.dispose()
  }
})

test('one failed start is counted once, however far apart its two reports are', async () => {
  // The readiness timeout is the slow report: the child's exit (or the teardown kill) reports
  // the same attempt again, seconds later. A 1 s wall-clock window could not see that those two
  // are one event; attempt identity can, and this is the test that would fail without it.
  process.env.DSH_BROWSER_READY_TIMEOUT_MS = '1200'
  process.env.PROTOCOL_CHILD_MODE = 'silent'
  const host = new RemoteElectronViewHost(fixture, process.execPath)
  const view = host.createView()
  try {
    const before = logLength()
    await assert.rejects(view.sendCommand('noop'))
    await wait(900)
    const tail = logSince(before)
    const failures = tail.split('\n').filter(line => line.includes('browser host start failed'))
    assert.equal(failures.length, 1, `exactly one failure line, got ${JSON.stringify(failures)}`)
    assert.match(failures[0], /attempt 1/, 'and it is the first attempt')
    assert.doesNotMatch(tail, /attempt 2/, 'the second report was not charged as a new attempt')
  } finally {
    host.dispose()
    delete process.env.DSH_BROWSER_READY_TIMEOUT_MS
  }
})

test('a failure report counts once per attempt, and a stale attempt never counts', () => {
  // The rule is identity, not a wall-clock window. It is pinned directly because the integration
  // test above cannot see the difference: with a real child, both reports of one attempt land in
  // the same millisecond, so a 1 s window would pass it too (an adversarial probe showed
  // exactly that). Two attempts are "far apart" here by construction, not by waiting.
  const { isNewStartFailure } = internals
  assert.equal(isNewStartFailure(7, 7, -1), true, 'the first report about the current attempt is news')
  assert.equal(isNewStartFailure(7, 7, 7), false, 'a second report about the same attempt is not')
  assert.equal(isNewStartFailure(6, 7, 6), false, 'a report about a superseded attempt is dropped')
  assert.equal(isNewStartFailure(8, 8, 7), true, 'the next attempt counts again')
})

test('the child filters forwarded events by the subscribed domains and cleans up after itself', () => {
  // The Electron-free fixture cannot exercise the real child's filter, so the contract is pinned
  // at the source: an adversarial probe correctly pointed out that "only subscribed domains are
  // forwarded" rested on code reading alone.
  const source = readFileSync(new URL('../src/browser-electron/host-main.ts', import.meta.url), 'utf8')
  assert.match(source, /debugger\.on\('message'/, 'the forwarder is installed on the view debugger')
  assert.match(source, /subscription\.domains\.has\(domain\)/, 'a domain the parent did not ask for is dropped')
  assert.match(source, /subscriptions\.delete\(viewId\)/, 'destroying a view drops its subscription')
  assert.match(source, /CDP_EVENT_BACKLOG_BYTES/, 'the socket backlog is capped')
  assert.match(source, /subscription\.dropped \+= 1/, 'dropped events are counted')
})
