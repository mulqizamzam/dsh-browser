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

import { BrowserError } from '../../browser/types.js'
import type { BrowserInstallCarrier, BrowserInstallRequest, BrowserInstallResult } from '../../browser/types.js'
import type { InstallDeps } from './deps.js'

/**
 * How much of an installer's output a report carries.
 *
 * The failure this feature exists to prevent is an installer that failed silently, so the tail
 * — where npm and the downloader put the actual error — always travels with the outcome. The
 * cap keeps a pathological multi-megabyte log from riding the RPC reply into the operator's
 * terminal or the model's context.
 */
const OUTPUT_TAIL_CHARS = 2_048

/**
 * Every carrier a status call asks about, in report order.
 *
 * All three are always probed, because "we did not look" and "we looked and it is not there"
 * are different answers and only one of them is actionable.
 */
const CARRIER_KINDS = ['electron', 'chrome', 'edge'] as const

/** One carrier kind. */
type CarrierKind = typeof CARRIER_KINDS[number]

/** The part of {@link InstallDeps} that a status report needs; narrow so the probe is pure. */
export type CarrierProbeDeps = Pick<InstallDeps, 'resolveElectron' | 'detectSystemBrowser' | 'channel'>

/** How a carrier is named to an operator. */
const PRODUCT_LABEL: Record<CarrierKind, string> = {
  electron: 'the bundled Electron runtime',
  chrome: 'Google Chrome',
  edge: 'Microsoft Edge',
}

/** The explicit override that makes detection succeed for a non-standard install. */
const PRODUCT_VARIABLE: Record<CarrierKind, string> = {
  electron: 'ELECTRON_PATH',
  chrome: 'DSH_BROWSER_CHROME_PATH',
  edge: 'DSH_BROWSER_EDGE_PATH',
}

/** Every carrier that was probed, whether or not it was found. */
export interface CarrierProbeResult {
  /** Every carrier that was looked for, found or not. */
  readonly carriers: readonly BrowserInstallCarrier[]
  /** The carrier channel the settings currently select. */
  readonly channel: string
  /** Whether the selected channel has a usable carrier right now. */
  readonly ready: boolean
  /** What the operator has to know; empty when the selected channel already works. */
  readonly notes: readonly string[]
}

/**
 * The carriers a channel can actually carry a session with.
 * @param channel - the settings' channel value; an unknown one falls back to the plugin's own runtime.
 * @returns the kinds that could satisfy this channel.
 */
function selectedKinds(channel: string): readonly CarrierKind[] {
  switch (channel) {
    case 'chrome':
      return ['chrome']
    case 'edge':
      return ['edge']
    // `auto` means "any browser will do", so every carrier is a candidate — the same rule the
    // provider uses when it decides whether to fall back to its own window.
    case 'auto':
      return CARRIER_KINDS
    // `bundled`, `sidebar`, and anything this build does not recognise: the plugin's own runtime.
    default:
      return ['electron']
  }
}

/**
 * Run one probe, treating a probe that throws as "not found".
 *
 * A status report is an observation, and it must not fail as a whole because one carrier's
 * lookup walked into a permission error or an unreadable directory: the other two answers are
 * still worth having.
 * @param probe - the lookup to run.
 * @returns what it returned, or undefined when it threw.
 */
function safely<T>(probe: () => T | undefined): T | undefined {
  try {
    return probe()
  } catch {
    return undefined
  }
}

/**
 * Probe the self-hosted carrier.
 * @param deps - the machine-scoped lookups.
 * @returns the carrier, with the path it resolves to even when that path is not there.
 */
function electronCarrier(deps: CarrierProbeDeps): BrowserInstallCarrier {
  const found = safely(() => deps.resolveElectron())
  if (found === undefined) return { kind: 'electron', exists: false }
  return {
    kind: 'electron',
    exists: found.exists,
    ...found.path !== '' ? { path: found.path } : {},
  }
}

/**
 * Probe one system browser.
 * @param kind - which product to ask about.
 * @param deps - the machine-scoped lookups.
 * @returns the carrier, with its version when the lookup could read one.
 */
function systemCarrier(kind: 'chrome' | 'edge', deps: CarrierProbeDeps): BrowserInstallCarrier {
  const found = safely(() => deps.detectSystemBrowser(kind))
  // A system carrier has no "exists but unusable" answer: the lookup either found an executable
  // or it did not.
  if (found === undefined) return { kind, exists: false }
  return {
    kind,
    exists: true,
    ...found.path !== '' ? { path: found.path } : {},
    ...found.version !== undefined ? { version: found.version } : {},
  }
}

/**
 * The remedy for one missing carrier, naming the channel that needs it.
 * @param channel - the selected channel, for the sentence the operator reads.
 * @param kind - the carrier that is missing.
 * @param bundledAvailable - whether the Electron carrier exists, which is the other way out.
 * @returns a note with the exact command or variable that fixes it.
 */
function remedyNote(channel: string, kind: CarrierKind, bundledAvailable: boolean): string {
  const label = PRODUCT_LABEL[kind]
  const variable = PRODUCT_VARIABLE[kind]
  if (kind === 'electron') {
    return `browser: the "${channel}" channel needs ${label}, and no Electron binary was found. Run \`npx install-electron\` in the active profile (it downloads the runtime), or point ELECTRON_PATH at an Electron binary you already have — then run browser_install again.`
  }
  const fallback = bundledAvailable
    ? ` The bundled Electron runtime is available, so switching the browser channel to "bundled" is the other way out.`
    : ''
  return `browser: the "${channel}" channel needs ${label}, and none was found on PATH or in the conventional install locations. Installing it at the OS level is what makes detection succeed; if it is already installed somewhere unusual, point ${variable} at its executable.${fallback}`
}

/**
 * Look for every carrier and work out whether the selected channel can carry a session.
 *
 * Exported so the readiness and note wording can be asserted without an installer, a download,
 * or a machine that happens to have Chrome on it.
 * @param deps - the machine-scoped lookups and the selected channel.
 * @returns the carrier list, readiness, and — only when the channel cannot work — the fixes.
 */
export function probeCarriers(deps: CarrierProbeDeps): CarrierProbeResult {
  const carriers: readonly BrowserInstallCarrier[] = [
    electronCarrier(deps),
    systemCarrier('chrome', deps),
    systemCarrier('edge', deps),
  ]
  const selected = selectedKinds(deps.channel)
  const ready = carriers.some(carrier => carrier.exists && selected.includes(carrier.kind))
  // Notes are only worth emitting when the channel has nothing to run: a `bundled` channel that
  // has its runtime does not need an essay about the Chrome it is not using, and the carrier
  // list above already reports each of them found or not.
  const bundledAvailable = carriers.some(carrier => carrier.kind === 'electron' && carrier.exists)
  const notes = ready
    ? []
    : carriers
      .filter(carrier => selected.includes(carrier.kind) && !carrier.exists)
      .map(carrier => remedyNote(deps.channel, carrier.kind, bundledAvailable))
  return { carriers, channel: deps.channel, ready, notes }
}

/**
 * The last of an installer's output, which is where the reason for a failure is printed.
 * @param output - everything the installer wrote.
 * @returns the tail, with a marker counting what was dropped.
 */
function outputTail(output: string): string {
  const trimmed = output.trim()
  if (trimmed.length <= OUTPUT_TAIL_CHARS) return trimmed
  const dropped = trimmed.length - OUTPUT_TAIL_CHARS
  return `…(${String(dropped)} earlier characters dropped)\n${trimmed.slice(dropped)}`
}

/** Why `target: 'system'` is refused, said once so both this module and its tests read it. */
const SYSTEM_INSTALL_REFUSED = 'browser: installing a system browser is not something this tool does — it needs root (an OS package manager or an OS installer), and a browser tool must not reach for sudo. Detection is the useful half and it already works: install Google Chrome or Microsoft Edge by any other means and `action: "status"` picks it up, and DSH_BROWSER_CHROME_PATH / DSH_BROWSER_EDGE_PATH covers an install in a non-standard location.'

/**
 * Install the bundled Electron runtime and report what appeared.
 *
 * Separate from the tool layer on purpose: the re-probe after the installer is the only thing
 * that can say whether the download actually produced a spawnable binary.
 * @param deps - the installer plus the lookups used to re-probe.
 * @returns the fresh carrier report, with `installed` filled in.
 */
async function installBundledElectron(deps: InstallDeps): Promise<BrowserInstallResult> {
  let outcome: { readonly ok: boolean; readonly output: string }
  try {
    outcome = await deps.installElectron()
  } catch (error) {
    // The installer itself blew up. Same code as a reported failure: from the operator's side
    // there is one problem — the install did not happen — and one place to read about it.
    throw new BrowserError(
      `browser: installing the bundled Electron runtime failed: ${String(error)}`,
      'BROWSER_INSTALL_FAILED',
      { cause: error },
    )
  }

  if (!outcome.ok) {
    const tail = outputTail(outcome.output)
    throw new BrowserError(
      `browser: installing the bundled Electron runtime failed.${tail === '' ? ' The installer printed nothing.' : ` Installer output (tail):\n${tail}`}`,
      'BROWSER_INSTALL_FAILED',
    )
  }

  // Re-probe rather than trust the exit status: the point of the action is the binary that
  // appeared, and only the probe can see it.
  const status = probeCarriers(deps)
  const electron = status.carriers.find(carrier => carrier.kind === 'electron')
  const tail = outputTail(outcome.output)
  const notes: string[] = []
  if (electron?.exists !== true) {
    // ok:true with nothing on disk is a real outcome (a truncated download, a blocked postinstall
    // that still exited 0), and reporting it as success is exactly the silent failure to avoid.
    notes.push(`browser: the installer reported success, but no Electron binary is at ${electron?.path ?? 'the expected location'} — re-run \`npx install-electron\`, or point ELECTRON_PATH at a binary you already have.`)
  }
  if (tail !== '') notes.push(`browser: install-electron output (tail):\n${tail}`)
  notes.push(...status.notes)

  return {
    ...status,
    notes,
    installed: {
      kind: 'electron',
      ...electron?.version !== undefined ? { version: electron.version } : {},
    },
  }
}

/**
 * Report carriers, or install one.
 * @param deps - machine-scoped primitives (carrier detection, the Electron installer).
 * @param request - `status` or `install`, and which target to install.
 * @returns the carrier list, readiness, and operator-facing notes.
 */
export async function manageInstall(deps: InstallDeps, request: BrowserInstallRequest): Promise<BrowserInstallResult> {
  if ((request.action ?? 'status') !== 'install') return probeCarriers(deps)
  if ((request.target ?? 'electron') === 'system') {
    throw new BrowserError(SYSTEM_INSTALL_REFUSED, 'BROWSER_INSTALL_UNSUPPORTED')
  }
  return await installBundledElectron(deps)
}
