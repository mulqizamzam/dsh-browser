/**
 * What a feature module may ask of the provider.
 *
 * The five feature families (PDF, tracing, video, network, install) all sit on the same four
 * primitives — send a CDP command, subscribe to CDP domains, listen to what comes back, and
 * write a file through the plugin's admission gate — so they take this one interface instead
 * of reaching into {@link ElectronBrowserProvider}. That keeps a feature testable with a
 * hand-written double (see tests/feature-pdf.test.mjs) and keeps the provider the only place
 * that knows about sessions, tabs, and view handles.
 *
 * @module dsh-builtin-browser/browser-electron/features/deps
 */
/**
 * Reject when `promise` has not settled within `ms`.
 *
 * A local copy on purpose: the three modules that already need this each keep their own
 * (host-main, provider, remote-host), and exporting one of those would put a feature module
 * behind a module it has no other reason to import.
 * @param promise - the work to bound.
 * @param ms - budget in milliseconds.
 * @param what - what to name in the rejection message.
 * @returns the promise's value, or a rejection naming the budget.
 */
export function withTimeout(promise, ms, what) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${what} timed out (${String(ms)}ms)`)), ms);
        promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))); });
    });
}
/** Interpret a `params` field that CDP documents as an object. */
export function asRecord(value) {
    return typeof value === 'object' && value !== null ? value : {};
}
/** Read a numeric field without trusting its type. */
export function asNumber(value) {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
/** Read a string field without trusting its type. */
export function asString(value) {
    return typeof value === 'string' ? value : undefined;
}
