// Trace capture: `Tracing.start` with ReturnAsStream, drained through `IO.read`, with the
// `Tracing.dataCollected` channel as the fallback and the admitted save path as the only place
// bytes may land.
//
// The provider hands a feature a fresh deps object per call, so `controlTrace` keeps its
// per-view state in the module. Every test therefore uses its own view id: two tests sharing
// one would share a trace.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { controlTrace } from '../lib/browser-electron/features/trace.js'

/**
 * A deps double: records every call it receives and answers CDP from a script.
 *
 * Hand-written on purpose (no mock library): the surface is four primitives, and writing them
 * out is what makes clear that the feature may not reach past them.
 * @param options - scripted replies: `endReply`, `reads` (one `IO.read` reply each, with an
 *   `Error` entry meaning "this read fails"), `admitError` (thrown by `admit`), `admitTo`.
 * @returns the deps, the recorded calls, the script controls, and an `emit` that delivers a
 *   forwarded CDP event to every listener the feature registered.
 */
function makeDeps(options = {}) {
  const calls = { send: [], subscribe: [], admit: [], writeFile: [], unsubscribes: 0 }
  const listeners = new Set()
  const control = {
    endReply: options.endReply ?? {},
    reads: [...(options.reads ?? [])],
    readIndex: 0,
    admitError: options.admitError ?? null,
    admitTo: options.admitTo ?? '/admitted/trace.json',
  }

  const deps = {
    async send(viewId, method, params) {
      calls.send.push({ viewId, method, params })
      if (method === 'Tracing.end') return control.endReply
      if (method === 'IO.read') {
        const reply = control.reads[control.readIndex++] ?? { eof: true }
        if (reply instanceof Error) throw reply
        return reply
      }
      return {}
    },
    async subscribe(viewId, domains) {
      calls.subscribe.push({ viewId, domains })
    },
    onEvent(viewId, listener) {
      listeners.add(listener)
      return () => { calls.unsubscribes += 1; listeners.delete(listener) }
    },
    admit(savePath, kind) {
      calls.admit.push({ savePath, kind })
      if (control.admitError) throw control.admitError
      return control.admitTo
    },
    async ffmpegPath() { return undefined },
    writeFile(path, data) {
      calls.writeFile.push({ path, bytes: data.byteLength, data })
    },
  }

  // Deliver an event the way the host would: synchronously, on the socket's data path.
  const emit = (method, params) => { for (const listener of [...listeners]) listener(method, params) }
  return { deps, calls, control, emit, listenerCount: () => listeners.size }
}

/** A base64 `IO.read` chunk of the trace stream, eof only when asked. */
function streamChunk(bytes, eof = false) {
  return { data: Buffer.from(bytes, 'utf8').toString('base64'), base64Encoded: true, eof }
}

test('a stop with no start in flight is BROWSER_TRACE_NOT_STARTED and sends nothing', async () => {
  const h = makeDeps()

  await assert.rejects(
    () => controlTrace(h.deps, 'view-not-started', { action: 'stop', savePath: '/admitted/trace.json' }),
    error => {
      assert.equal(error.code, 'BROWSER_TRACE_NOT_STARTED')
      return true
    },
  )
  // Not just the code: a stop that never had a trace must not end one, and must not read a
  // path it is not allowed to use.
  assert.deepEqual(h.calls.send, [])
  assert.deepEqual(h.calls.admit, [])
  assert.deepEqual(h.calls.writeFile, [])
})

test('a start then stop over the trace stream writes exactly the chunked bytes', async () => {
  const partA = '[{"name":"a"}'
  const partB = ',{"name":"b"}]'
  const h = makeDeps({
    endReply: { stream: 'handle-1' },
    reads: [streamChunk(partA), streamChunk(partB), { eof: true }],
  })

  assert.deepEqual(await controlTrace(h.deps, 'view-stream', { action: 'start' }), { tracing: true })

  // No transferMode: stream mode suppresses `Tracing.dataCollected`, and the carriers this
  // plugin drives do not hand a stream handle back either — a live trace that asked for one
  // wrote an empty file. A stream handle IS still honoured when a carrier returns one, which
  // is what the rest of this test covers.
  const start = h.calls.send.find(call => call.method === 'Tracing.start')
  assert.deepEqual(start.params, { categories: 'devtools.timeline' })
  assert.equal(h.calls.subscribe[0].viewId, 'view-stream')

  const result = await controlTrace(h.deps, 'view-stream', { action: 'stop', savePath: 'trace.json' })

  assert.equal(result.tracing, false)
  assert.equal(result.path, '/admitted/trace.json')
  assert.equal(result.bytes, Buffer.byteLength(partA + partB))
  assert.equal(result.truncated, false)

  const written = h.calls.writeFile[0]
  assert.equal(written.path, '/admitted/trace.json')
  assert.equal(written.bytes, result.bytes)
  assert.deepEqual(written.data, Buffer.from(partA + partB, 'utf8'))

  // The handle from Tracing.end is what the reads address.
  const reads = h.calls.send.filter(call => call.method === 'IO.read')
  assert.equal(reads.length, 3)
  for (const read of reads) {
    assert.equal(read.params.handle, 'handle-1')
    assert.ok(Number.isInteger(read.params.size) && read.params.size > 0)
  }
})

test('a streamed trace closes the stream handle it read from', async () => {
  const h = makeDeps({
    endReply: { stream: 'handle-close' },
    reads: [streamChunk('[]', true)],
  })

  await controlTrace(h.deps, 'view-close', { action: 'start' })
  await controlTrace(h.deps, 'view-close', { action: 'stop', savePath: 'trace.json' })

  assert.deepEqual(
    h.calls.send.filter(call => call.method === 'IO.close'),
    [{ viewId: 'view-close', method: 'IO.close', params: { handle: 'handle-close' } }],
  )
  // Closing after the last read, not instead of it: the bytes are taken first.
  const methods = h.calls.send.map(call => call.method)
  assert.ok(methods.lastIndexOf('IO.read') < methods.indexOf('IO.close'))
})

test('a read that fails is BROWSER_TRACE_FAILED with the cause chained, and still closes the handle', async () => {
  const h = makeDeps({
    endReply: { stream: 'handle-broken' },
    reads: [new Error('IO.read exploded')],
  })

  await controlTrace(h.deps, 'view-read-failure', { action: 'start' })
  await assert.rejects(
    () => controlTrace(h.deps, 'view-read-failure', { action: 'stop', savePath: 'trace.json' }),
    error => {
      assert.equal(error.code, 'BROWSER_TRACE_FAILED')
      assert.equal(error.cause?.message, 'IO.read exploded')
      return true
    },
  )
  // A failed read must not leave the whole trace pinned in the browser.
  assert.deepEqual(
    h.calls.send.filter(call => call.method === 'IO.close').map(call => call.params.handle),
    ['handle-broken'],
  )
  assert.deepEqual(h.calls.writeFile, [])
  // The trace is over either way: a second stop must not claim one is running.
  await assert.rejects(
    () => controlTrace(h.deps, 'view-read-failure', { action: 'stop', savePath: 'trace.json' }),
    error => {
      assert.equal(error.code, 'BROWSER_TRACE_NOT_STARTED')
      return true
    },
  )
})

test('when Tracing.end returns no stream, the collected dataCollected chunks are written and the listener is released', async () => {
  // No `stream` in the reply: the host ignored ReturnAsStream, so the trace came over the
  // event channel `start` armed.
  const h = makeDeps({ endReply: {} })

  await controlTrace(h.deps, 'view-fallback', { action: 'start' })
  assert.deepEqual(h.calls.subscribe.map(call => call.domains), [['Tracing']])
  assert.equal(h.listenerCount(), 1)

  h.emit('Tracing.dataCollected', { value: [{ name: 'a' }] })
  h.emit('Tracing.dataCollected', { value: [{ name: 'b' }] })
  // Not a trace chunk: ignored rather than appended.
  h.emit('Tracing.dataCollected', { value: [] })
  h.emit('Page.loadEventFired', { timestamp: 1 })
  // What a browser actually sends once the trace is over; without it `stop` waits out its flush
  // budget, which is the behaviour the next test pins.
  h.emit('Tracing.tracingComplete', {})
  assert.equal(h.listenerCount(), 1)

  const result = await controlTrace(h.deps, 'view-fallback', { action: 'stop', savePath: 'trace.json' })

  const written = h.calls.writeFile[0].data.toString('utf8')
  assert.deepEqual(JSON.parse(written), { traceEvents: [{ name: 'a' }, { name: 'b' }] })
  assert.equal(result.bytes, Buffer.byteLength(written))
  assert.equal(result.path, '/admitted/trace.json')
  // No handle means nothing to read from, so the stream path must not be taken.
  assert.deepEqual(h.calls.send.filter(call => call.method === 'IO.read'), [])
  assert.deepEqual(h.calls.send.filter(call => call.method === 'IO.close'), [])
  // The listener outlives the trace only as a leak.
  assert.equal(h.calls.unsubscribes, 1)
  assert.equal(h.listenerCount(), 0)
})

test('a stop without a savePath is BROWSER_TRACE_NO_PATH and leaves the trace running', async () => {
  const h = makeDeps({ endReply: { stream: 'handle-nopath' }, reads: [streamChunk('[]', true)] })

  await controlTrace(h.deps, 'view-no-path', { action: 'start' })
  await assert.rejects(
    () => controlTrace(h.deps, 'view-no-path', { action: 'stop' }),
    error => {
      assert.equal(error.code, 'BROWSER_TRACE_NO_PATH')
      return true
    },
  )
  assert.deepEqual(h.calls.admit, [])

  // Still tracing, so the stop can be retried once the caller supplies a destination.
  const result = await controlTrace(h.deps, 'view-no-path', { action: 'stop', savePath: 'trace.json' })
  assert.equal(result.bytes, 2)
})

test('a refused path rejects with the admit error before any CDP work on stop', async () => {
  const refusal = Object.assign(new Error('browser: "outside.json" must be inside downloadDir'), {
    code: 'BROWSER_TRACE_BLOCKED',
  })
  const h = makeDeps({ admitError: refusal })

  await controlTrace(h.deps, 'view-refused', { action: 'start' })
  const sentBefore = h.calls.send.length

  await assert.rejects(
    () => controlTrace(h.deps, 'view-refused', { action: 'stop', savePath: 'outside.json' }),
    error => {
      // The gate's own error, not one this module invents: the caller has to see the reason.
      assert.equal(error, refusal)
      assert.equal(error.code, 'BROWSER_TRACE_BLOCKED')
      return true
    },
  )
  assert.deepEqual(h.calls.admit, [{ savePath: 'outside.json', kind: 'trace' }])
  assert.deepEqual(h.calls.send.slice(sentBefore), [])
  assert.deepEqual(h.calls.writeFile, [])

  // The trace was never ended, so it is still there to save once the path is admitted.
  h.control.admitError = null
  h.control.endReply = { stream: 'handle-refused' }
  h.control.reads = [streamChunk('[]', true)]
  const result = await controlTrace(h.deps, 'view-refused', { action: 'stop', savePath: 'inside.json' })
  assert.equal(result.path, '/admitted/trace.json')
  assert.ok(h.calls.send.slice(sentBefore).some(call => call.method === 'Tracing.end'))
})

test('a second start for the same view replaces the first instead of leaking its listener', async () => {
  const h = makeDeps({ endReply: { stream: 'handle-replaced' }, reads: [streamChunk('[]', true)] })

  await controlTrace(h.deps, 'view-restart', { action: 'start' })
  await controlTrace(h.deps, 'view-restart', { action: 'start' })

  assert.equal(h.listenerCount(), 1)
  assert.equal(h.calls.unsubscribes, 1)
  assert.equal(h.calls.send.filter(call => call.method === 'Tracing.start').length, 2)

  const result = await controlTrace(h.deps, 'view-restart', { action: 'stop', savePath: 'trace.json' })
  assert.equal(result.tracing, false)
  assert.equal(h.listenerCount(), 0)
  assert.equal(h.calls.unsubscribes, 2)
})

test('start does not ask for stream transfer, which costs every event on Electron', async () => {
  // Regression for a defect a live run found: with `transferMode: 'ReturnAsStream'` Chromium
  // stops emitting `Tracing.dataCollected`, AND Electron 44's `Tracing.end` handed back no
  // stream handle — so a trace of a real page wrote 2 bytes and zero events. Events are the
  // transport that exists on every carrier, so the request must not ask for the stream.
  const { deps, calls } = makeDeps()
  await controlTrace(deps, 'view-stream-mode', { action: 'start' })
  const start = calls.send.find(call => call.method === 'Tracing.start')
  assert.ok(start !== undefined, 'Tracing.start was sent')
  assert.ok(!('transferMode' in start.params), `transferMode must not be requested, got ${JSON.stringify(start.params)}`)
  assert.equal(typeof start.params.categories, 'string', 'the category set still travels')
  await controlTrace(deps, 'view-stream-mode', { action: 'stop', savePath: '/admitted/trace.json' })
})

test('the flush that arrives after Tracing.end is awaited, not lost', async () => {
  // A live trace against Electron wrote an empty array (2 bytes): `Tracing.end` answers before
  // the browser hands over the final `dataCollected`/`tracingComplete`, and the file was
  // assembled at the reply. This test delivers the chunk only AFTER end resolves — the real
  // ordering — and would fail on the version that wrote immediately.
  const h = makeDeps({ endReply: {} })
  await controlTrace(h.deps, 'view-flush', { action: 'start' })

  const original = h.deps.send
  h.deps.send = async (viewId, method, params) => {
    const reply = await original(viewId, method, params)
    if (method === 'Tracing.end') {
      // The browser's own ordering: the reply first, then the remaining events.
      setImmediate(() => {
        h.emit('Tracing.dataCollected', { value: [{ name: 'after-end' }] })
        h.emit('Tracing.tracingComplete', {})
      })
    }
    return reply
  }

  const result = await controlTrace(h.deps, 'view-flush', { action: 'stop', savePath: 'trace.json' })
  assert.deepEqual(JSON.parse(h.calls.writeFile[0].data.toString('utf8')), { traceEvents: [{ name: 'after-end' }] }, 'the late chunk reached the file')
  assert.ok(result.bytes > 2, 'and the file is not an empty array')
})

test('a carrier that never sends tracingComplete still gets its file, after the budget', async () => {
  // The wait must be bounded: a browser that dies mid-trace, or one that simply does not emit
  // the completion event, cannot hang the tool.
  const h = makeDeps({ endReply: {} })
  await controlTrace(h.deps, 'view-nocomplete', { action: 'start' })
  h.emit('Tracing.dataCollected', { value: [{ name: 'partial' }] })
  const started = Date.now()
  await controlTrace(h.deps, 'view-nocomplete', { action: 'stop', savePath: 'trace.json' })
  const elapsed = Date.now() - started
  assert.deepEqual(JSON.parse(h.calls.writeFile[0].data.toString('utf8')), { traceEvents: [{ name: 'partial' }] }, 'what arrived is still written')
  assert.ok(elapsed >= 4_000, `the flush budget was waited out (${String(elapsed)}ms)`)
  assert.ok(elapsed < 15_000, `but it is bounded (${String(elapsed)}ms)`)
})
