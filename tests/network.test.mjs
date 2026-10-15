// browser_network, driven through the built feature module with a hand-written FeatureDeps
// double. The events below are the shapes the host forwards off the CDP socket, so what is
// exercised here is the fold from event to entry, the filters, the buffer cap and the body call
// — not a mock's idea of them.
//
// Every test owns its own viewId: the module keeps one recording per view, and sharing an id
// would make one test's buffer visible to the next.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { inspectNetwork } from '../lib/browser-electron/features/network.js'

/** CDP timestamps are seconds with a fractional part, on the browser's own clock. */
const T0 = 1_700_000_000

/** Bytes a body may carry before it is cut. */
const MAX_BODY_BYTES = 1024 * 1024

/**
 * A FeatureDeps double: `send` is recorded, `onEvent` hands back the listener so a test can
 * deliver events exactly as the provider would from the socket.
 * @param options - `send` overrides the CDP reply for one call.
 * @returns the double and the recorded calls.
 */
function makeDeps(options = {}) {
  const calls = { send: [], subscribe: [] }
  const listeners = new Map()
  return {
    calls,
    /** Deliver one forwarded CDP event to whatever the module subscribed for the view. */
    emit(viewId, method, params) {
      for (const listener of [...listeners.get(viewId) ?? []]) listener(method, params)
    },
    /** How many listeners the module currently holds for the view. */
    listenerCount: viewId => (listeners.get(viewId) ?? new Set()).size,
    send: async (viewId, method, params) => {
      calls.send.push({ viewId, method, params })
      if (options.send !== undefined) return await options.send({ viewId, method, params })
      return {}
    },
    subscribe: async (viewId, domains) => { calls.subscribe.push({ viewId, domains: [...domains] }) },
    onEvent: (viewId, listener) => {
      const set = listeners.get(viewId) ?? new Set()
      set.add(listener)
      listeners.set(viewId, set)
      return () => { set.delete(listener) }
    },
    admit: savePath => savePath,
    ffmpegPath: async () => undefined,
    writeFile: () => {},
  }
}

/** The `requestWillBeSent` event for one request. */
function emitRequest(deps, viewId, { requestId, url, method = 'GET', resourceType = 'Fetch', startedAt = T0 }) {
  deps.emit(viewId, 'Network.requestWillBeSent', {
    requestId,
    loaderId: 'loader-1',
    documentURL: url,
    timestamp: startedAt,
    wallTime: startedAt,
    type: resourceType,
    request: { url, method, headers: {} },
  })
}

/** The `responseReceived` event for one request. */
function emitResponse(deps, viewId, { requestId, url, resourceType = 'Fetch', status = 200, statusText = 'OK', mimeType = 'application/json' }) {
  deps.emit(viewId, 'Network.responseReceived', {
    requestId,
    loaderId: 'loader-1',
    timestamp: T0 + 0.02,
    type: resourceType,
    response: { url, status, statusText, mimeType, headers: {}, fromCache: false },
  })
}

/** A whole request -> response -> finished sequence, the way a served request arrives. */
function emitExchange(deps, viewId, options) {
  const { requestId, url, method = 'GET', resourceType = 'Fetch', status = 200, statusText = 'OK', mimeType = 'application/json', encodedBytes = 1234 } = options
  emitRequest(deps, viewId, { requestId, url, method, resourceType })
  emitResponse(deps, viewId, { requestId, url, resourceType, status, statusText, mimeType })
  deps.emit(viewId, 'Network.loadingFinished', { requestId, timestamp: T0 + 0.05, encodedDataLength: encodedBytes })
}

/** A request that failed instead of answering, optionally after a response was seen. */
function emitFailure(deps, viewId, options) {
  const { requestId, url, method = 'GET', resourceType = 'Fetch', status, errorText = 'net::ERR_FAILED' } = options
  emitRequest(deps, viewId, { requestId, url, method, resourceType })
  if (status !== undefined) {
    emitResponse(deps, viewId, { requestId, url, resourceType, status, statusText: 'Internal Server Error' })
  }
  deps.emit(viewId, 'Network.loadingFailed', { requestId, timestamp: T0 + 0.03, type: resourceType, errorText, canceled: false })
}

/** The request ids of a list result, in the order it returned them. */
function ids(result) {
  return result.entries.map(entry => entry.requestId)
}

/**
 * The BrowserError code a rejected call carried. Asserting on `code` rather than on the message
 * is the point: the message is for a human, the code is what a caller routes on.
 * @param promise - the call that must reject.
 * @returns the code.
 */
async function codeOf(promise) {
  try {
    await promise
  } catch (error) {
    return error.code
  }
  throw new Error('expected the call to reject, but it resolved')
}

test('start enables the Network domain, records an exchange and lists it', async () => {
  const deps = makeDeps()
  const started = await inspectNetwork(deps, 'view-happy', { action: 'start' })

  assert.equal(started.recording, true)
  assert.deepEqual(started.entries, [], 'start returns no rows')
  assert.equal(started.total, 0)
  assert.deepEqual(deps.calls.subscribe, [{ viewId: 'view-happy', domains: ['Network'] }])
  assert.ok(deps.calls.send.some(call => call.method === 'Network.enable'), 'start enables the domain')

  emitExchange(deps, 'view-happy', {
    requestId: 'req-1',
    url: 'https://api.example.com/v1/users',
    method: 'GET',
    resourceType: 'Fetch',
    status: 200,
    statusText: 'OK',
    mimeType: 'application/json',
    encodedBytes: 4321,
  })

  const listed = await inspectNetwork(deps, 'view-happy', { action: 'list' })
  assert.equal(listed.recording, true)
  assert.equal(listed.total, 1)
  assert.equal(listed.dropped, 0)
  assert.deepEqual(listed.entries, [{
    requestId: 'req-1',
    url: 'https://api.example.com/v1/users',
    method: 'GET',
    resourceType: 'Fetch',
    status: 200,
    statusText: 'OK',
    mimeType: 'application/json',
    fromCache: false,
    encodedBytes: 4321,
    startedAtMs: T0 * 1000,
    durationMs: 50,
  }])
})

test('list filters by substring, /regex/, type, method, status and failure', async () => {
  const deps = makeDeps()
  await inspectNetwork(deps, 'view-filter', { action: 'start' })

  emitExchange(deps, 'view-filter', { requestId: 'r1', url: 'https://api.example.com/v1/users', resourceType: 'XHR', status: 200 })
  emitExchange(deps, 'view-filter', { requestId: 'r2', url: 'https://cdn.example.com/app.js', resourceType: 'Script', status: 304, statusText: 'Not Modified' })
  emitExchange(deps, 'view-filter', { requestId: 'r3', url: 'https://api.example.com/v1/login', method: 'POST', resourceType: 'Fetch', status: 401, statusText: 'Unauthorized' })
  emitFailure(deps, 'view-filter', { requestId: 'r4', url: 'https://api.example.com/v1/broken', method: 'POST', status: 500, errorText: 'net::ERR_CONNECTION_RESET' })
  emitExchange(deps, 'view-filter', { requestId: 'r5', url: 'https://example.com/logo.png', resourceType: 'Image', status: 200, mimeType: 'image/png' })

  const matches = async query => ids(await inspectNetwork(deps, 'view-filter', { action: 'list', ...query }))

  assert.deepEqual(await matches({}), ['r5', 'r4', 'r3', 'r2', 'r1'])
  assert.deepEqual(await matches({ urlPattern: 'api.example.com' }), ['r4', 'r3', 'r1'])
  assert.deepEqual(await matches({ urlPattern: '/\\.js$/' }), ['r2'], 'a /regex/ literal')
  assert.deepEqual(await matches({ urlPattern: 'logo.png' }), ['r5'], 'a bare pattern is a substring')
  assert.deepEqual(await matches({ urlPattern: '(unclosed' }), [], 'a bare pattern is never compiled — that one would not parse as a regex')
  assert.deepEqual(await matches({ resourceType: 'xhr' }), ['r1'], 'resourceType is case-insensitive')
  assert.deepEqual(await matches({ method: 'post' }), ['r4', 'r3'], 'method is case-insensitive')
  assert.deepEqual(await matches({ status: 200 }), ['r5', 'r1'], 'status is exact')
  assert.deepEqual(await matches({ onlyFailed: true }), ['r4'])
  assert.deepEqual(await matches({ onlyFailed: true, method: 'POST' }), ['r4'], 'filters combine')

  assert.equal(
    await codeOf(inspectNetwork(deps, 'view-filter', { action: 'list', urlPattern: '/[/' })),
    'BROWSER_NETWORK_BAD_PATTERN',
    'an uncompilable pattern is an error, not an empty list',
  )
  assert.equal(
    await codeOf(inspectNetwork(deps, 'view-never-started', { action: 'list', urlPattern: '/[/' })),
    'BROWSER_NETWORK_BAD_PATTERN',
    'the pattern is compiled before the buffer is consulted',
  )
})

test('the buffer stops at 500 entries and counts what it evicted', async () => {
  const deps = makeDeps()
  await inspectNetwork(deps, 'view-ring', { action: 'start' })
  for (let i = 0; i < 503; i += 1) {
    emitRequest(deps, 'view-ring', { requestId: `r${i}`, url: `https://example.com/${i}` })
  }

  const listed = await inspectNetwork(deps, 'view-ring', { action: 'list', limit: 200 })
  assert.equal(listed.total, 500, 'the ring buffer is capped')
  assert.equal(listed.dropped, 3, 'the three oldest were evicted and counted')
  assert.equal(listed.entries.length, 200, 'limit caps the rows')
  assert.equal(listed.entries[0].requestId, 'r502', 'newest first')
  assert.equal(listed.entries[listed.entries.length - 1].requestId, 'r303', 'and the oldest survivors are still there')
})

test('body passes CDP base64 through, cuts at 1 MiB, and reports a body CDP no longer has', async () => {
  const payload = Buffer.from('hello network').toString('base64')
  const deps = makeDeps({ send: ({ method }) => (method === 'Network.getResponseBody' ? { body: payload, base64Encoded: true } : {}) })
  await inspectNetwork(deps, 'view-body', { action: 'start' })
  emitExchange(deps, 'view-body', { requestId: 'req-body', url: 'https://api.example.com/v1/blob' })

  const got = await inspectNetwork(deps, 'view-body', { action: 'body', requestId: 'req-body' })
  assert.equal(got.body, payload)
  assert.equal(got.base64, true)
  assert.notEqual(got.truncated, true)
  assert.deepEqual(
    deps.calls.send[deps.calls.send.length - 1],
    { viewId: 'view-body', method: 'Network.getResponseBody', params: { requestId: 'req-body' } },
  )

  // A plain body stays plain, and the flag says so.
  const text = makeDeps({ send: () => ({ body: '{"ok":true}', base64Encoded: false }) })
  await inspectNetwork(text, 'view-body-text', { action: 'start' })
  const plain = await inspectNetwork(text, 'view-body-text', { action: 'body', requestId: 'req-text' })
  assert.equal(plain.body, '{"ok":true}')
  assert.equal(plain.base64, false)

  // One byte over the cap: the body is cut, and what comes back is still the base64 it claims
  // to be — a sliced base64 string would not be.
  const big = Buffer.alloc(MAX_BODY_BYTES + 17, 0x61)
  const bulky = makeDeps({ send: () => ({ body: big.toString('base64'), base64Encoded: true }) })
  await inspectNetwork(bulky, 'view-body-big', { action: 'start' })
  const cut = await inspectNetwork(bulky, 'view-body-big', { action: 'body', requestId: 'req-big' })
  assert.equal(cut.truncated, true)
  assert.equal(cut.base64, true)
  assert.equal(Buffer.from(cut.body, 'base64').byteLength, MAX_BODY_BYTES)

  assert.equal(
    await codeOf(inspectNetwork(deps, 'view-body', { action: 'body' })),
    'BROWSER_NETWORK_NO_REQUEST_ID',
    'body without a requestId is refused by code',
  )

  const evicted = makeDeps({
    send: ({ method }) => {
      if (method === 'Network.getResponseBody') throw new Error('No resource with given identifier found')
      return {}
    },
  })
  await inspectNetwork(evicted, 'view-gone', { action: 'start' })
  assert.equal(
    await codeOf(inspectNetwork(evicted, 'view-gone', { action: 'body', requestId: 'req-evicted' })),
    'BROWSER_NETWORK_BODY_GONE',
    'CDP forgetting the body is not an empty string',
  )
})

test('stop disables the domain, drops the listener and empties the buffer', async () => {
  const deps = makeDeps()
  await inspectNetwork(deps, 'view-stop', { action: 'start' })
  emitExchange(deps, 'view-stop', { requestId: 'req-1', url: 'https://example.com/' })
  assert.equal(deps.listenerCount('view-stop'), 1)

  const stopped = await inspectNetwork(deps, 'view-stop', { action: 'stop' })
  assert.equal(stopped.recording, false)
  assert.deepEqual(stopped.entries, [], 'stop returns no rows')
  assert.equal(stopped.total, 0, 'and nothing is buffered afterwards')
  assert.ok(deps.calls.send.some(call => call.method === 'Network.disable'), 'stop disables the domain')
  assert.equal(deps.listenerCount('view-stop'), 0, 'the listener is unsubscribed')

  // A straggler that the unsubscribe raced is not recorded.
  emitRequest(deps, 'view-stop', { requestId: 'req-2', url: 'https://example.com/late' })
  const listed = await inspectNetwork(deps, 'view-stop', { action: 'list' })
  assert.equal(listed.recording, false)
  assert.deepEqual(listed.entries, [])
  assert.equal(listed.total, 0)

  // Stopping something that never started is a no-op, not an error.
  const nothing = await inspectNetwork(deps, 'view-never-started-stop', { action: 'stop' })
  assert.equal(nothing.recording, false)
  assert.equal(nothing.total, 0)
})

test('clear empties the buffer and keeps recording', async () => {
  const deps = makeDeps()
  await inspectNetwork(deps, 'view-clear', { action: 'start' })
  emitExchange(deps, 'view-clear', { requestId: 'req-1', url: 'https://example.com/' })

  const cleared = await inspectNetwork(deps, 'view-clear', { action: 'clear' })
  assert.equal(cleared.recording, true)
  assert.equal(cleared.total, 0)
  assert.deepEqual(cleared.entries, [])

  emitExchange(deps, 'view-clear', { requestId: 'req-2', url: 'https://example.com/after' })
  const listed = await inspectNetwork(deps, 'view-clear', { action: 'list' })
  assert.deepEqual(ids(listed), ['req-2'], 'recording continued after the clear')
  assert.equal(listed.total, 1)
})

test('list returns newest first and limit caps the rows', async () => {
  const deps = makeDeps()
  await inspectNetwork(deps, 'view-order', { action: 'start' })
  for (let i = 1; i <= 5; i += 1) emitExchange(deps, 'view-order', { requestId: `r${i}`, url: `https://example.com/${i}` })

  const all = await inspectNetwork(deps, 'view-order', { action: 'list' })
  assert.deepEqual(ids(all), ['r5', 'r4', 'r3', 'r2', 'r1'])
  assert.equal(all.total, 5)

  const two = await inspectNetwork(deps, 'view-order', { action: 'list', limit: 2 })
  assert.deepEqual(ids(two), ['r5', 'r4'])
  assert.equal(two.total, 5, 'total counts the buffer, not the returned rows')

  const cold = await inspectNetwork(deps, 'view-cold', { action: 'list' })
  assert.deepEqual(
    { recording: cold.recording, rows: cold.entries.length, total: cold.total, dropped: cold.dropped },
    { recording: false, rows: 0, total: 0, dropped: 0 },
    'a view that never started answers instead of throwing',
  )
})

test('an event the buffer has no request for still becomes an entry, and junk is ignored', async () => {
  const deps = makeDeps()
  await inspectNetwork(deps, 'view-robust', { action: 'start' })

  // The request's own event was missed (a subscription that started mid-flight): the response
  // is still worth keeping.
  deps.emit('view-robust', 'Network.responseReceived', {
    requestId: 'late-1',
    type: 'Document',
    response: { url: 'https://example.com/late', status: 204, statusText: 'No Content' },
  })
  const late = await inspectNetwork(deps, 'view-robust', { action: 'list' })
  assert.deepEqual(late.entries, [{
    requestId: 'late-1',
    url: 'https://example.com/late',
    method: '',
    resourceType: 'Document',
    status: 204,
    statusText: 'No Content',
  }])

  // The listener sits on the socket's data path: nothing an event can carry may throw there.
  assert.doesNotThrow(() => {
    deps.emit('view-robust', 'Network.requestWillBeSent', { requestId: 42, request: 'not an object', timestamp: 'soon' })
    deps.emit('view-robust', 'Network.loadingFinished', { encodedDataLength: 'lots' })
    deps.emit('view-robust', 'Network.loadingFailed', { requestId: 'late-1', errorText: 7 })
    deps.emit('view-robust', 'Network.webSocketFrameReceived', { requestId: 'late-1' })
    deps.emit('view-robust', 'Page.loadEventFired', { timestamp: T0 })
  })

  const survived = await inspectNetwork(deps, 'view-robust', { action: 'list' })
  assert.deepEqual(ids(survived), ['late-1'], 'the later events folded into the one entry')
  assert.equal(survived.entries[0].failed, 'failed', 'a failure without errorText still counts as failed')
  assert.equal(survived.entries[0].status, 204, 'and the response it did report is still there')
  assert.deepEqual(ids(await inspectNetwork(deps, 'view-robust', { action: 'list', onlyFailed: true })), ['late-1'])
})
