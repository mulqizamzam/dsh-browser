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
import { BrowserError } from '../../browser/types.js';
import { asNumber, asRecord, asString } from './deps.js';
/** Entries kept per view before the oldest is evicted. `'start'` has no `limit` field, so this default is what is always in force. */
const DEFAULT_BUFFER_CAP = 500;
/** Ceiling a per-start buffer size would have to respect; the provider holds these entries per live view. */
const HARD_BUFFER_CAP = 2000;
/** The cap actually in force. */
const BUFFER_CAP = Math.min(DEFAULT_BUFFER_CAP, HARD_BUFFER_CAP);
/** Rows `'list'` returns when the caller does not ask for a count. */
const DEFAULT_LIST_LIMIT = 50;
/** Ceiling on returned rows: every row crosses the RPC reply and is read by a model. */
const MAX_LIST_LIMIT = 200;
/** Response bodies are fetched on demand and cut here; the whole body crosses the RPC reply as a string. */
const MAX_BODY_BYTES = 1024 * 1024;
/** A `/regex/` literal with optional flags, and nothing else, is treated as a regular expression. */
const REGEX_LITERAL = /^\/(.*)\/([a-z]*)$/s;
/**
 * Recording state per view. Module-level on purpose: the provider builds a fresh `FeatureDeps`
 * for every call, so the state cannot live on the deps object.
 */
const recordings = new Map();
/**
 * Control or read the network log of the view behind `viewId`.
 * @param deps - the provider primitives.
 * @param viewId - the backing view of the session's active tab.
 * @param request - the action plus its filters.
 * @returns recording state, the matching entries, and any requested body.
 */
export async function inspectNetwork(deps, viewId, request) {
    switch (request.action) {
        case 'start': return await start(deps, viewId);
        case 'stop': return await stop(deps, viewId);
        case 'clear': return clear(viewId);
        case 'list': return list(viewId, request);
        case 'body': return await readBody(deps, viewId, request);
        default:
            throw new BrowserError(`browser: unknown network action '${String(request.action)}'`, 'BROWSER_NETWORK_BAD_ACTION');
    }
}
/**
 * Begin recording the view's network events.
 * @param deps - the provider primitives.
 * @param viewId - the view to record.
 * @returns the empty, recording state.
 */
async function start(deps, viewId) {
    // A second 'start' replaces the recording; dropping the previous listener first is what keeps
    // events from being folded in twice.
    teardown(recordings.get(viewId));
    const state = { entries: [], byId: new Map(), dropped: 0, recording: false };
    const listener = (method, params) => {
        // This runs on the socket's data path: append and return. No awaits — an event that is
        // never acknowledged would stall every other event behind it — and no throws, because a
        // single malformed event must not take the connection down.
        try {
            if (recordings.get(viewId) !== state || !state.recording)
                return;
            fold(state, method, params);
        }
        catch {
            // Deliberately swallowed: the buffer is a diagnostic, the socket is the product.
        }
    };
    await deps.subscribe(viewId, ['Network']);
    // The listener goes on before `Network.enable` so nothing that the enable itself provokes is
    // missed, and comes off again if the enable fails.
    const unsubscribe = deps.onEvent(viewId, listener);
    state.unsubscribe = unsubscribe;
    state.recording = true;
    recordings.set(viewId, state);
    try {
        await deps.send(viewId, 'Network.enable');
    }
    catch (error) {
        // Nothing is recording: report the failure instead of leaving a state that claims to.
        teardown(state);
        recordings.delete(viewId);
        throw error;
    }
    return reply(state, []);
}
/**
 * Stop recording the view and disable the domain.
 * @param deps - the provider primitives.
 * @param viewId - the view to stop.
 * @returns the emptied, non-recording state.
 */
async function stop(deps, viewId) {
    const state = recordings.get(viewId);
    try {
        await deps.send(viewId, 'Network.disable');
    }
    finally {
        // Even a refused disable stops recording locally: a listener that keeps appending after the
        // caller asked to stop is worse than a stale CDP subscription.
        teardown(state);
        recordings.delete(viewId);
    }
    return reply(state, []);
}
/**
 * Empty the buffer without ending the recording.
 * @param viewId - the view to clear.
 * @returns the recording state with nothing buffered. `dropped` survives: it counts what the cap
 * took, not what is still held.
 */
function clear(viewId) {
    const state = recordings.get(viewId);
    if (state !== undefined) {
        state.entries.length = 0;
        state.byId.clear();
    }
    return reply(state, []);
}
/**
 * Read back the buffered entries.
 * @param viewId - the view to read.
 * @param request - the filters and the row cap.
 * @returns the matching entries, newest first.
 */
function list(viewId, request) {
    // Compiled before the buffer is consulted: an unusable pattern is refused even when nothing
    // is buffered, because an empty list would look like "nothing matched".
    const matchesPattern = patternMatcher(request.urlPattern);
    const state = recordings.get(viewId);
    if (state === undefined)
        return reply(state, []);
    const matching = state.entries.filter(entry => matchesPattern(entry.url) && matchesFilters(entry, request));
    return reply(state, matching.slice(0, resolveLimit(request.limit)));
}
/**
 * Fetch one response body from CDP.
 * @param deps - the provider primitives.
 * @param viewId - the view to ask.
 * @param request - carrying the `requestId` to fetch.
 * @returns the body, its encoding, and whether it was cut.
 */
async function readBody(deps, viewId, request) {
    const requestId = request.requestId;
    if (requestId === undefined || requestId === '') {
        throw new BrowserError("browser: network 'body' needs a requestId", 'BROWSER_NETWORK_NO_REQUEST_ID');
    }
    let answer;
    try {
        answer = await deps.send(viewId, 'Network.getResponseBody', { requestId });
    }
    catch (error) {
        // CDP keeps a body only until the page navigates or the renderer goes away, and there is no
        // second chance to ask; say so instead of handing back an empty string.
        throw new BrowserError(`browser: the response body for "${requestId}" is no longer available: ${String(error)}`, 'BROWSER_NETWORK_BODY_GONE', { cause: error });
    }
    const body = asString(answer.body);
    if (body === undefined) {
        throw new BrowserError(`browser: CDP returned no body for "${requestId}"`, 'BROWSER_NETWORK_BODY_GONE');
    }
    const base64 = answer.base64Encoded === true;
    const cut = cutBody(body, base64);
    return {
        ...reply(recordings.get(viewId), []),
        body: cut.text,
        base64,
        ...cut.truncated ? { truncated: true } : {},
    };
}
/**
 * Cut a body at the byte cap.
 * @param body - what CDP returned.
 * @param base64 - whether it is base64-encoded.
 * @returns the body and whether it was cut. An uncut body is returned byte for byte; a cut one is
 * measured in bytes and, when base64, re-encoded so the flag stays true of what is returned.
 */
function cutBody(body, base64) {
    const bytes = base64 ? Buffer.from(body, 'base64') : Buffer.from(body, 'utf8');
    if (bytes.byteLength <= MAX_BODY_BYTES)
        return { text: body, truncated: false };
    const kept = bytes.subarray(0, MAX_BODY_BYTES);
    return { text: base64 ? kept.toString('base64') : kept.toString('utf8'), truncated: true };
}
/**
 * Detach the listener and drop what was buffered.
 * @param state - the recording to tear down, when there is one.
 */
function teardown(state) {
    if (state === undefined)
        return;
    state.recording = false;
    state.unsubscribe?.();
    state.unsubscribe = undefined;
    state.entries.length = 0;
    state.byId.clear();
}
/**
 * Shape the reply every action returns.
 * @param state - the view's state, when it has one.
 * @param entries - the rows for this action.
 * @returns the shared fields plus whatever the action added.
 */
function reply(state, entries) {
    return {
        recording: state?.recording ?? false,
        entries,
        total: state?.entries.length ?? 0,
        dropped: state?.dropped ?? 0,
    };
}
/**
 * Build the URL filter for one `urlPattern`.
 * @param pattern - a substring, a `/regex/` literal, or nothing.
 * @returns the predicate, or a predicate that always matches when no pattern was given.
 */
function patternMatcher(pattern) {
    if (pattern === undefined || pattern === '')
        return () => true;
    const literal = REGEX_LITERAL.exec(pattern);
    if (literal === null)
        return url => url.includes(pattern);
    let regex;
    try {
        regex = new RegExp(literal[1] ?? '', literal[2] ?? '');
    }
    catch (error) {
        throw new BrowserError(`browser: urlPattern "${pattern}" is not a valid regular expression: ${String(error)}`, 'BROWSER_NETWORK_BAD_PATTERN', { cause: error });
    }
    return url => regex.test(url);
}
/**
 * Apply the non-URL filters.
 * @param entry - the buffered entry.
 * @param request - the filters.
 * @returns whether the entry passes all of them.
 */
function matchesFilters(entry, request) {
    if (request.resourceType !== undefined && !equalsIgnoreCase(entry.resourceType, request.resourceType))
        return false;
    if (request.method !== undefined && !equalsIgnoreCase(entry.method, request.method))
        return false;
    if (request.status !== undefined && entry.status !== request.status)
        return false;
    if (request.onlyFailed === true && entry.failed === undefined)
        return false;
    return true;
}
/**
 * Case-insensitive equality against a field CDP may never have reported.
 * @param value - the entry's value, when it has one.
 * @param wanted - the caller's filter.
 * @returns whether they match.
 */
function equalsIgnoreCase(value, wanted) {
    return value !== undefined && value.toLowerCase() === wanted.toLowerCase();
}
/**
 * Clamp the requested row count.
 * @param limit - the caller's `limit`, untrusted.
 * @returns a finite count within `[0, MAX_LIST_LIMIT]`.
 */
function resolveLimit(limit) {
    if (limit === undefined || !Number.isFinite(limit))
        return DEFAULT_LIST_LIMIT;
    return Math.min(Math.max(Math.trunc(limit), 0), MAX_LIST_LIMIT);
}
/**
 * The entry for `requestId`, created when an event names an id nothing has recorded yet.
 * @param state - the recording.
 * @param requestId - the id the event named.
 * @param url - what the event knew about the URL, when it knew anything.
 * @returns the entry, buffered and indexed.
 */
function entryFor(state, requestId, url) {
    const known = state.byId.get(requestId);
    if (known !== undefined)
        return known;
    const entry = { requestId, url, method: '' };
    state.byId.set(requestId, entry);
    state.entries.unshift(entry);
    if (state.entries.length > BUFFER_CAP) {
        const evicted = state.entries.pop();
        // Identity, not just the id: an id can be reused after its first entry was evicted, and that
        // must not drop the mapping of whichever entry holds it now.
        if (evicted !== undefined && state.byId.get(evicted.requestId) === evicted)
            state.byId.delete(evicted.requestId);
        if (evicted !== undefined)
            state.dropped += 1;
    }
    return entry;
}
/**
 * Fold one CDP event into the buffer. Never called for anything but the four Network events.
 * @param state - the recording.
 * @param method - the CDP event name.
 * @param params - the event payload, untrusted.
 */
function fold(state, method, params) {
    switch (method) {
        case 'Network.requestWillBeSent': {
            const requestId = asString(params.requestId);
            if (requestId === undefined)
                return;
            const request = asRecord(params.request);
            const entry = entryFor(state, requestId, asString(request.url) ?? '');
            entry.url = asString(request.url) ?? entry.url;
            entry.method = asString(request.method) ?? entry.method;
            entry.resourceType = asString(params.type) ?? entry.resourceType;
            const timestamp = asNumber(params.timestamp);
            if (timestamp !== undefined)
                entry.startedAtMs = Math.round(timestamp * 1000);
            return;
        }
        case 'Network.responseReceived': {
            const requestId = asString(params.requestId);
            if (requestId === undefined)
                return;
            const response = asRecord(params.response);
            const entry = entryFor(state, requestId, asString(response.url) ?? '');
            const status = asNumber(response.status);
            if (status !== undefined)
                entry.status = status;
            const statusText = asString(response.statusText);
            if (statusText !== undefined)
                entry.statusText = statusText;
            const mimeType = asString(response.mimeType);
            if (mimeType !== undefined)
                entry.mimeType = mimeType;
            // Real responses report where they came from rather than a bare `fromCache`, so all three
            // spellings mean the same thing here.
            const fromCache = asBoolean(response.fromCache) ?? asBoolean(response.fromDiskCache) ?? asBoolean(response.fromPrefetchCache);
            if (fromCache !== undefined)
                entry.fromCache = fromCache;
            entry.resourceType = asString(params.type) ?? entry.resourceType;
            return;
        }
        case 'Network.loadingFinished': {
            const requestId = asString(params.requestId);
            if (requestId === undefined)
                return;
            const entry = entryFor(state, requestId, '');
            const encoded = asNumber(params.encodedDataLength);
            if (encoded !== undefined)
                entry.encodedBytes = encoded;
            const durationMs = elapsedMs(entry, params.timestamp);
            if (durationMs !== undefined)
                entry.durationMs = durationMs;
            return;
        }
        case 'Network.loadingFailed': {
            const requestId = asString(params.requestId);
            if (requestId === undefined)
                return;
            const entry = entryFor(state, requestId, '');
            entry.failed = asString(params.errorText) ?? 'failed';
            const durationMs = elapsedMs(entry, params.timestamp);
            if (durationMs !== undefined)
                entry.durationMs = durationMs;
            return;
        }
        default: return;
    }
}
/**
 * Milliseconds from the request's start to this event.
 * @param entry - the entry, which knows `startedAtMs` when the send was seen.
 * @param timestamp - the event's CDP timestamp, in seconds.
 * @returns the duration, or undefined when either end is unknown.
 */
function elapsedMs(entry, timestamp) {
    const at = asNumber(timestamp);
    if (at === undefined || entry.startedAtMs === undefined)
        return undefined;
    return Math.max(0, Math.round(at * 1000) - entry.startedAtMs);
}
/** Read a boolean field without trusting its type. */
function asBoolean(value) {
    return typeof value === 'boolean' ? value : undefined;
}
/**
 * Drop whatever a destroyed view left behind.
 *
 * The network log is the one feature buffer that grows with page activity, and its listener
 * keeps the closure alive; without this, a view destroyed while recording would hold both
 * until the process exits. The provider calls this when a session or tab goes away.
 * @param viewId - the view that no longer exists.
 */
export function releaseNetworkView(viewId) {
    const state = recordings.get(viewId);
    if (state === undefined)
        return;
    recordings.delete(viewId);
    state.unsubscribe?.();
}
