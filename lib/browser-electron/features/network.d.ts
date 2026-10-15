/**
 * Inspect the network activity of the active tab.
 *
 * CONTRACT (implemented in this file)
 *  - `action: 'start'` subscribes the `Network` domain and issues `Network.enable`, then
 *    buffers every `Network.requestWillBeSent` / `responseReceived` / `loadingFinished` /
 *    `loadingFailed` event for that view into a bounded ring buffer (default 500 entries, hard
 *    cap 2000). Entries evicted by the cap are counted as `dropped`.
 *  - `action: 'list'` returns buffered entries, newest first, filtered by `urlPattern`
 *    (substring, or a `/regex/` literal), `resourceType`, `method`, `status`, `onlyFailed`,
 *    capped by `limit` (default 50, max 200).
 *  - `action: 'body'` fetches `Network.getResponseBody` for one `requestId` and returns it,
 *    base64-encoded when CDP says so. Bodies are only fetched on demand — buffering them would
 *    hold every response in memory — and CDP forgets them across a navigation, so a miss is
 *    reported as `BROWSER_NETWORK_BODY_GONE` rather than an empty string. Cap: 1 MiB, with
 *    `truncated: true` when cut.
 *  - `action: 'clear'` empties the buffer; `'stop'` issues `Network.disable` and clears it.
 *  - Nothing here fetches bodies automatically and nothing blocks the event path: the listener
 *    only appends to the ring buffer.
 *  - Every reply carries `recording` / `entries` / `total` / `dropped`; a bad `urlPattern`
 *    regex is `BROWSER_NETWORK_BAD_PATTERN`, and `'body'` without a `requestId` is
 *    `BROWSER_NETWORK_NO_REQUEST_ID`.
 *
 * @module dsh-builtin-browser/browser-electron/features/network
 */
import type { BrowserNetworkRequest, BrowserNetworkResult } from '../../browser/types.js';
import { type FeatureDeps } from './deps.js';
/**
 * Control or read the network log of the view behind `viewId`.
 * @param deps - the provider primitives.
 * @param viewId - the backing view of the session's active tab.
 * @param request - the action plus its filters.
 * @returns recording state, the matching entries, and any requested body.
 */
export declare function inspectNetwork(deps: FeatureDeps, viewId: string, request: BrowserNetworkRequest): Promise<BrowserNetworkResult>;
/**
 * Drop whatever a destroyed view left behind.
 *
 * The network log is the one feature buffer that grows with page activity, and its listener
 * keeps the closure alive; without this, a view destroyed while recording would hold both
 * until the process exits. The provider calls this when a session or tab goes away.
 * @param viewId - the view that no longer exists.
 */
export declare function releaseNetworkView(viewId: string): void;
