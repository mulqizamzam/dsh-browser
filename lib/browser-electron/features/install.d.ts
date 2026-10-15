/**
 * Report the browser carriers this installation can use, and install the one it can install.
 *
 * CONTRACT (implemented in this file)
 *  - `action: 'status'` (the default) lists every carrier it asked about with the path it
 *    resolved, its version when one can be read without launching it, and whether it exists.
 *    `source` stays unset: {@link InstallDeps} reports a resolved path, not how it was found.
 *    `ready` is true when the channel the settings select has a usable carrier. Nothing is
 *    downloaded or started here.
 *  - `action: 'install'` with `target: 'electron'` runs the bundled Electron package's own
 *    installer through `deps.installElectron()` and reports the version that appeared. This is
 *    a real ~100 MB download, which is why it is an action and not a side effect of `status`.
 *  - `action: 'install'` with `target: 'system'` refuses with `BROWSER_INSTALL_UNSUPPORTED`, and
 *    the refusal message carries the way out: installing a system browser needs root, and a
 *    browser tool must not reach for sudo. Detection is the useful half, and it already works —
 *    a browser installed by any other means is picked up by `status`.
 *  - `notes` carries what the operator has to know: a missing Electron binary and the exact
 *    command that fixes it, an unset `DSH_BROWSER_CHROME_PATH`/`DSH_BROWSER_EDGE_PATH` override
 *    when detection failed on a non-standard install, the selected channel, and the tail of the
 *    installer's output.
 *
 * @module dsh-builtin-browser/browser-electron/features/install
 */
import type { BrowserInstallCarrier, BrowserInstallRequest, BrowserInstallResult } from '../../browser/types.js';
import type { InstallDeps } from './deps.js';
/** The part of {@link InstallDeps} that a status report needs; narrow so the probe is pure. */
export type CarrierProbeDeps = Pick<InstallDeps, 'resolveElectron' | 'detectSystemBrowser' | 'channel'>;
/** Every carrier that was probed, whether or not it was found. */
export interface CarrierProbeResult {
    /** Every carrier that was looked for, found or not. */
    readonly carriers: readonly BrowserInstallCarrier[];
    /** The carrier channel the settings currently select. */
    readonly channel: string;
    /** Whether the selected channel has a usable carrier right now. */
    readonly ready: boolean;
    /** What the operator has to know; empty when the selected channel already works. */
    readonly notes: readonly string[];
}
/**
 * Look for every carrier and work out whether the selected channel can carry a session.
 *
 * Exported so the readiness and note wording can be asserted without an installer, a download,
 * or a machine that happens to have Chrome on it.
 * @param deps - the machine-scoped lookups and the selected channel.
 * @returns the carrier list, readiness, and — only when the channel cannot work — the fixes.
 */
export declare function probeCarriers(deps: CarrierProbeDeps): CarrierProbeResult;
/**
 * Report carriers, or install one.
 * @param deps - machine-scoped primitives (carrier detection, the Electron installer).
 * @param request - `status` or `install`, and which target to install.
 * @returns the carrier list, readiness, and operator-facing notes.
 */
export declare function manageInstall(deps: InstallDeps, request: BrowserInstallRequest): Promise<BrowserInstallResult>;
