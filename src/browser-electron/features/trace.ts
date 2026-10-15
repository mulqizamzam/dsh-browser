/**
 * Record a Chrome trace of the active tab.
 *
 * CONTRACT (implemented in this file)
 *  - `action: 'start'` subscribes the `Tracing` domain and collects `Tracing.dataCollected`
 *    through `deps.onEvent`. It deliberately does NOT ask for `transferMode: 'ReturnAsStream'`:
 *    Chromium suppresses those events in stream mode, and Electron's CDP returns no stream
 *    handle either, so a stream-first trace wrote an empty file on this plugin's own carrier.
 *    When a carrier does hand a `stream` handle back from `Tracing.end`, it is read and takes
 *    precedence — the events are then empty anyway.
 *  - `action: 'stop'` ends the trace, closes the stream (`IO.close`), writes the JSON to
 *    `request.savePath` (required) through `deps.admit(..., 'trace')` + `deps.writeFile`, and
 *    reports `bytes`.
 *  - A `stop` with no start in flight is `BROWSER_TRACE_NOT_STARTED`; a `stop` without a
 *    `savePath` is `BROWSER_TRACE_NO_PATH`; a failed CDP call is `BROWSER_TRACE_FAILED` with
 *    the cause chained.
 *  - Caps: the trace is assembled in memory, so accumulation stops at 256 MiB rather than
 *    growing without bound; what was read is still written and reported as `truncated: true`.
 *
 * @module dsh-builtin-browser/browser-electron/features/trace
 */

import { BrowserError } from '../../browser/types.js'
import type { BrowserTraceRequest, BrowserTraceResult } from '../../browser/types.js'
import { withTimeout, asRecord, asString, type FeatureDeps } from './deps.js'

/** The category set used when the caller names none: the timeline events DevTools shows. */
const DEFAULT_CATEGORIES = 'devtools.timeline'

/**
 * Ceiling on the trace held in memory. A minute of timeline on a busy page is tens of
 * megabytes, and every byte is held twice (here and in the host's socket buffer), so an
 * unbounded read is a way to lose the process; past the cap the read stops and the file is
 * written with what arrived, marked `truncated`.
 */
const MAX_TRACE_BYTES = 256 * 1024 * 1024

/** Bytes asked for per `IO.read`; the 64 KiB default turns a large trace into a round-trip storm. */
const READ_SIZE = 1 << 20

/** `Tracing.start` answers immediately, or refuses a category set outright. */
const START_TIMEOUT_MS = 10_000

/** `Tracing.end` assembles the trace in the browser; a page that never goes idle can be slow. */
const END_TIMEOUT_MS = 30_000

/** One `IO.read`/`IO.close` answers at once — the budget only exists so a stuck host cannot hang the tool. */
const READ_TIMEOUT_MS = 30_000

/**
 * How long to wait for `Tracing.tracingComplete` after `Tracing.end`.
 *
 * The end reply is not the end of the data: the browser flushes the last `dataCollected` (and
 * then `tracingComplete`) right AFTER answering it. A live trace written at the reply held an
 * empty array — 2 bytes — because everything was still in flight.
 */
const TRACE_FLUSH_TIMEOUT_MS = 5_000

/** What the view's in-flight trace is being read into. */
interface TraceState {
  /** Trace bytes read back from the `IO.read` stream. */
  readonly chunks: Buffer[]
  /** `Tracing.dataCollected` payloads, used when `Tracing.end` hands back no stream handle. */
  readonly eventChunks: unknown[][]
  /** Bytes accumulated across both channels, checked against {@link MAX_TRACE_BYTES}. */
  bytes: number
  /** True once the cap cut the trace short. */
  truncated: boolean
  /** True once `Tracing.tracingComplete` arrived: the flush after `Tracing.end` is done. */
  complete: boolean
  /** Waiters for {@link complete}, resolved by the event listener. */
  readonly waiters: (() => void)[]
  /** Detaches the `Tracing` listener registered by `start`. */
  unsubscribe: () => void
}

/**
 * Per-view trace state.
 *
 * Module-level because the provider builds a fresh deps object per call, so `stop` would have
 * nothing to find on `deps`; keyed by view so two tabs can be traced independently. A second
 * `start` for the same view takes the entry over (and releases its listener) instead of
 * stacking a second one.
 */
const traces = new Map<string, TraceState>()

/**
 * Start or stop a trace of the view behind `viewId`.
 * @param deps - the provider primitives.
 * @param viewId - the backing view of the session's active tab.
 * @param request - `start` or `stop`, plus the destination for `stop`.
 * @returns whether tracing is now active, and for a stop the written path and size.
 */
export async function controlTrace(deps: FeatureDeps, viewId: string, request: BrowserTraceRequest): Promise<BrowserTraceResult> {
  return request.action === 'start' ? await startTrace(deps, viewId, request) : await stopTrace(deps, viewId, request)
}

/**
 * Begin a trace and arm both read-back channels.
 * @param deps - the provider primitives.
 * @param viewId - the view to trace.
 * @param request - the start request (categories only).
 * @returns `{ tracing: true }` once the browser has accepted the start.
 */
async function startTrace(deps: FeatureDeps, viewId: string, request: BrowserTraceRequest): Promise<BrowserTraceResult> {
  const categories = request.categories !== undefined && request.categories.length > 0
    ? request.categories.join(',')
    : DEFAULT_CATEGORIES

  // The listener is armed BEFORE the trace runs: `Tracing.dataCollected` payloads that arrive
  // between start and end cannot be replayed by subscribing after `Tracing.end` has been sent,
  // so a lazy subscription would collect nothing. This is the primary channel, not a fallback —
  // see the note on `Tracing.start` below.
  await deps.subscribe(viewId, ['Tracing'])
  const state: TraceState = { chunks: [], eventChunks: [], bytes: 0, truncated: false, complete: false, waiters: [], unsubscribe: () => undefined }
  state.unsubscribe = deps.onEvent(viewId, (method, params) => { collectEvent(state, method, params) })

  // Deliberately NOT `transferMode: 'ReturnAsStream'`. Chromium stops emitting
  // `Tracing.dataCollected` in that mode, and Electron's CDP hands back no stream handle for
  // `Tracing.end` — so a live trace against Electron 44 wrote an empty file (measured: 2 bytes,
  // zero events). Events are the transport every carrier has; a stream handle is still read when
  // one does come back, which costs nothing.
  try {
    await withTimeout(
      deps.send(viewId, 'Tracing.start', { categories }),
      START_TIMEOUT_MS,
      'CDP Tracing.start',
    )
  } catch (error) {
    state.unsubscribe()
    throw new BrowserError(`browser: starting the trace failed: ${String(error)}`, 'BROWSER_TRACE_FAILED', { cause: error })
  }

  // Take over from a previous start on this view: dropping the old state without releasing its
  // listener would leave the host forwarding events into a closure nobody can reach.
  traces.get(viewId)?.unsubscribe()
  traces.set(viewId, state)
  return { tracing: true }
}

/**
 * Buffer one forwarded CDP event.
 *
 * Runs on the socket's data path, so it appends and returns — no awaits, no throws.
 * @param state - the view's trace state.
 * @param method - the forwarded CDP method.
 * @param params - its parameters.
 */
function collectEvent(state: TraceState, method: string, params: Record<string, unknown>): void {
  if (method === 'Tracing.tracingComplete') {
    state.complete = true
    for (const waiter of state.waiters.splice(0)) waiter()
    return
  }
  if (method !== 'Tracing.dataCollected') return
  const value = asRecord(params).value
  // CDP sends one array of trace events per notification; anything else is not a chunk.
  if (!Array.isArray(value) || value.length === 0) return
  const size = Buffer.byteLength(JSON.stringify(value), 'utf8')
  if (state.bytes + size > MAX_TRACE_BYTES) {
    state.truncated = true
    return
  }
  state.bytes += size
  state.eventChunks.push(value as unknown[])
}

/**
 * End the trace and write it to the admitted destination.
 * @param deps - the provider primitives.
 * @param viewId - the view being traced.
 * @param request - the stop request; `savePath` is required.
 * @returns the written path, its size, and whether the cap cut it short.
 */
async function stopTrace(deps: FeatureDeps, viewId: string, request: BrowserTraceRequest): Promise<BrowserTraceResult> {
  const state = traces.get(viewId)
  if (state === undefined) {
    throw new BrowserError(
      'browser: no trace is running for this view, so there is nothing to stop',
      'BROWSER_TRACE_NOT_STARTED',
    )
  }

  const savePath = request.savePath
  if (typeof savePath !== 'string' || savePath.trim() === '') {
    throw new BrowserError('browser: stopping a trace needs an absolute savePath for the trace JSON', 'BROWSER_TRACE_NO_PATH')
  }

  // Admit BEFORE any CDP work: a refused destination costs nothing, the trace is still running
  // afterwards, and the caller can retry the stop with a path it is allowed to write.
  const target = deps.admit(savePath, 'trace')

  // Past this point the trace is being torn down, so the entry must go: a second stop (or a
  // stop after a failure below) must not report a trace the browser has already ended.
  traces.delete(viewId)

  let end: Record<string, unknown>
  try {
    end = await withTimeout(deps.send(viewId, 'Tracing.end'), END_TIMEOUT_MS, 'CDP Tracing.end')
  } catch (error) {
    state.unsubscribe()
    throw new BrowserError(`browser: ending the trace failed: ${String(error)}`, 'BROWSER_TRACE_FAILED', { cause: error })
  }

  // The end reply is not the end of the data. When the carrier handed back a stream handle,
  // everything is already in that stream; otherwise the last chunks arrive as events right
  // after this point, and the file must not be assembled without them.
  if (asString(asRecord(end).stream) === undefined && !state.complete) {
    await new Promise<void>(resolve => {
      const timer = setTimeout(resolve, TRACE_FLUSH_TIMEOUT_MS)
      state.waiters.push(() => { clearTimeout(timer); resolve() })
    })
  }

  const bytes = await collectTrace(deps, viewId, end, state)

  // A carrier can accept `Tracing.start`, answer `Tracing.end`, and hand over nothing at all
  // (measured: a WebContents debugger that supports the domain but records no chunks). Writing
  // that as a successful 18-byte `{"traceEvents":[]}` is the failure this feature exists to
  // avoid: the caller cannot tell it apart from a real trace of an idle page.
  if (state.eventChunks.length === 0 && state.chunks.length === 0) {
    throw new BrowserError(
      'browser: the trace came back empty — the carrier accepted Tracing.start and Tracing.end but handed over no events',
      'BROWSER_TRACE_EMPTY',
    )
  }
  try {
    deps.writeFile(target, bytes)
  } catch (error) {
    throw new BrowserError(`browser: writing the trace to "${target}" failed: ${String(error)}`, 'BROWSER_TRACE_FAILED', { cause: error })
  }
  return { tracing: false, path: target, bytes: bytes.byteLength, truncated: state.truncated }
}

/**
 * Take the finished trace out of the channel the host actually used.
 * @param deps - the provider primitives.
 * @param viewId - the view that was traced.
 * @param end - the `Tracing.end` reply, which carries the stream handle when there is one.
 * @param state - the view's trace state.
 * @returns the trace JSON as bytes.
 */
async function collectTrace(deps: FeatureDeps, viewId: string, end: Record<string, unknown>, state: TraceState): Promise<Buffer> {
  try {
    const handle = asString(end.stream)
    if (handle !== undefined) return await readStream(deps, viewId, handle, state)
    // No handle: the data came over the event channel that `start` armed. Written as
    // `{ traceEvents: [...] }` — the shape Chromium itself streams — so a caller never has to
    // know which of the two routes produced the file.
    return Buffer.from(JSON.stringify({ traceEvents: state.eventChunks.flat() }), 'utf8')
  } catch (error) {
    throw new BrowserError(`browser: reading the trace back failed: ${String(error)}`, 'BROWSER_TRACE_FAILED', { cause: error })
  } finally {
    // The last `Tracing.dataCollected` flush rides with `Tracing.end`, so the listener is
    // detached only once the data has been taken — and also when taking it failed.
    state.unsubscribe()
  }
}

/**
 * Drain a `ReturnAsStream` trace handle into memory and close it.
 * @param deps - the provider primitives.
 * @param viewId - the view being traced.
 * @param handle - the stream handle from `Tracing.end`.
 * @param state - the view's trace state, which accumulates the chunks.
 * @returns the concatenated trace bytes.
 */
async function readStream(deps: FeatureDeps, viewId: string, handle: string, state: TraceState): Promise<Buffer> {
  try {
    for (;;) {
      const read = await withTimeout(
        deps.send(viewId, 'IO.read', { handle, size: READ_SIZE }),
        READ_TIMEOUT_MS,
        'CDP IO.read',
      )
      const data = asString(read.data) ?? ''
      if (data !== '') {
        // CDP hands the trace back base64; the flag is the authority if a host ever says plain.
        const chunk = read.base64Encoded === false ? Buffer.from(data, 'utf8') : Buffer.from(data, 'base64')
        if (state.bytes + chunk.byteLength > MAX_TRACE_BYTES) {
          state.truncated = true
          break
        }
        state.bytes += chunk.byteLength
        state.chunks.push(chunk)
      }
      if (read.eof === true) break
      // Neither an empty read nor a spent cap can make progress, and looping on either would
      // hang the tool with the browser holding the whole trace.
      if (data === '') break
    }
  } finally {
    // The handle holds the trace in the browser's memory until it is closed — including on a
    // truncated read or a failed one, which is why the close lives in a `finally`. A close that
    // fails has nothing left to save, so it must not replace the trace data with an error.
    try {
      await withTimeout(deps.send(viewId, 'IO.close', { handle }), READ_TIMEOUT_MS, 'CDP IO.close')
    } catch {
      // Deliberately ignored: the bytes already read are the result.
    }
  }
  return Buffer.concat(state.chunks)
}

/**
 * Drop whatever a destroyed view left behind.
 *
 * Feature state is keyed by viewId and holds real memory — here, the bytes read back from a
 * trace in progress — so a view destroyed mid-recording would otherwise keep both the buffer
 * and its event listener reachable until the process exits. The provider calls this when a
 * session or tab goes away.
 * @param viewId - the view that no longer exists.
 */
export function releaseTraceView(viewId: string): void {
  const state = traces.get(viewId)
  if (state === undefined) return
  traces.delete(viewId)
  state.unsubscribe()
}
