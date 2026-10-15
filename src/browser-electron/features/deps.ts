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

import type { BrowserPdfRequest } from '../../browser/types.js'

/** The provider primitives a feature module is allowed to use. */
export interface FeatureDeps {
  /**
   * Send one CDP command to the view and resolve with its `result` object.
   * @param viewId - the backing view of the session's active tab.
   * @param method - CDP method, e.g. `Page.printToPDF`.
   * @param params - CDP parameters.
   * @param timeoutMs - how long the command may take before it is reported as timed out.
   */
  send(viewId: string, method: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
  /**
   * Ask the host to forward these CDP domains for the view, in addition to whatever is
   * already forwarded. Idempotent, and always re-sent in full so a restarted host (which
   * forwards nothing) converges without bookkeeping.
   * @param viewId - the view to subscribe.
   * @param domains - CDP domain names such as `Network` or `Page`.
   */
  subscribe(viewId: string, domains: readonly string[]): Promise<void>
  /**
   * Listen to forwarded CDP events for one view.
   * @param viewId - the view to listen to.
   * @param listener - called on the socket's data path: it must not block or await.
   * @returns an unsubscribe function; calling it twice is harmless.
   */
  onEvent(viewId: string, listener: (method: string, params: Record<string, unknown>) => void): () => void
  /**
   * Admit a save path and return the resolved absolute path.
   *
   * Same gate as a download: absolute, inside the configured downloadDir, symlinks resolved,
   * and an existing file is never overwritten. Throws a `BrowserError` when refused.
   * @param savePath - the caller's requested path.
   * @param kind - which error code a refusal carries.
   */
  admit(savePath: string, kind: 'pdf' | 'trace' | 'video'): string
  /**
   * The ffmpeg executable to encode video with, or undefined when none can be found.
   * Resolved lazily: a session that never records a video never probes for ffmpeg.
   */
  ffmpegPath(): Promise<string | undefined>
  /**
   * Optional: render the view to PDF with the carrier's own print pipeline, returning the
   * document base64-encoded.
   *
   * Absent on a carrier whose CDP really implements `Page.printToPDF` (an installed Chrome or
   * Edge); present where CDP does not — Electron's in-process debugger answers every other
   * method but not that one, which is the only reason this escape hatch exists.
   */
  nativePdf?(viewId: string, request: BrowserPdfRequest): Promise<{ readonly base64: string }>
  /**
   * Write bytes durably: a temp file beside the target, then a rename, so a crash mid-write
   * leaves a `.part` file rather than a half-written artifact at the final path.
   * @param path - an already-admitted absolute path.
   * @param data - the complete contents.
   */
  writeFile(path: string, data: Buffer): void
}

/** The provider primitives the install feature needs — machine-scoped, not view-scoped. */
export interface InstallDeps {
  /** Where the self-hosted carrier's Electron binary would be, with an existence check. */
  resolveElectron(): { readonly path: string; readonly exists: boolean } | undefined
  /** Detect an installed Chrome or Edge, with its version when one could be read. */
  detectSystemBrowser(kind: 'chrome' | 'edge'): { readonly path: string; readonly version?: string } | undefined
  /** The carrier channel the settings currently select (`bundled`, `chrome`, `edge`). */
  readonly channel: string
  /**
   * Run the bundled Electron package's own installer — the documented
   * `npx install-electron` step — and resolve with its outcome. Network access and roughly
   * 100 MB of download; the caller has already been gated on the operator's switches.
   */
  installElectron(): Promise<{ readonly ok: boolean; readonly output: string }>
}

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
export function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out (${String(ms)}ms)`)), ms)
    promise.then(
      value => { clearTimeout(timer); resolve(value) },
      error => { clearTimeout(timer); reject(error instanceof Error ? error : new Error(String(error))) },
    )
  })
}

/** Interpret a `params` field that CDP documents as an object. */
export function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
}

/** Read a numeric field without trusting its type. */
export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Read a string field without trusting its type. */
export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}
