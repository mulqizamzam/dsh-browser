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
import type { BrowserTraceRequest, BrowserTraceResult } from '../../browser/types.js';
import { type FeatureDeps } from './deps.js';
/**
 * Start or stop a trace of the view behind `viewId`.
 * @param deps - the provider primitives.
 * @param viewId - the backing view of the session's active tab.
 * @param request - `start` or `stop`, plus the destination for `stop`.
 * @returns whether tracing is now active, and for a stop the written path and size.
 */
export declare function controlTrace(deps: FeatureDeps, viewId: string, request: BrowserTraceRequest): Promise<BrowserTraceResult>;
/**
 * Drop whatever a destroyed view left behind.
 *
 * Feature state is keyed by viewId and holds real memory — here, the bytes read back from a
 * trace in progress — so a view destroyed mid-recording would otherwise keep both the buffer
 * and its event listener reachable until the process exits. The provider calls this when a
 * session or tab goes away.
 * @param viewId - the view that no longer exists.
 */
export declare function releaseTraceView(viewId: string): void;
