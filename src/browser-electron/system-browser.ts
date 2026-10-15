/**
 * Drive the browser the user already has (Chrome / Edge / any Chromium) instead of
 * the Electron we ship — the same approach Codex Browser Use takes.
 *
 * WHY
 * The bundled Electron is a private copy with its own profile, so it can never see
 * the logins the user already has in Chrome, and on a managed machine the user may
 * simply prefer their own browser. Launching their browser with a *separate*
 * `--user-data-dir` gives us a real Chromium we can drive over CDP without touching
 * their everyday profile, bookmarks or windows: nothing of theirs is opened, locked
 * or modified, and closing us never closes them.
 *
 * HOW
 * Chromium exposes CDP on `--remote-debugging-port=0`, and writes the port it chose
 * into `<profile>/DevToolsActivePort`. That file is the discovery mechanism — no
 * port guessing, no collisions. From there everything is CDP over one WebSocket:
 * `Target.createTarget` makes a page, `Target.attachToTarget` (flattened) gives a
 * session for it, and the plugin's commands ride that session. Node 22 ships a global
 * `WebSocket`, so this needs no dependency at all.
 *
 * ATTACHING
 * A deployment can also point this carrier at a browser that is ALREADY running, by setting
 * `cdpEndpoint` (or `DSH_BROWSER_CDP_ENDPOINT`) to that browser's
 * `ws://host:port/devtools/browser/<id>` URL, or to the `http://host:port` origin whose
 * `/json/version` publishes it. Nothing is spawned then, no profile directory is claimed,
 * created or removed, and the browser is NOT killed when the session ends — it was never ours;
 * the operator started it, quite possibly with their own windows in it. An endpoint that cannot
 * be reached says so, by name, and starts nothing: falling back to a launch would hand the
 * operator a different browser than the one they asked for.
 *
 * WHAT IT IMPLEMENTS
 * The same `ElectronBrowserViewHost` seam as the self-hosted and sidebar hosts, so
 * the provider, the tools, history, the cursor and teardown rules are unchanged —
 * only the carrier differs.
 * @module dsh-browser/browser-electron/system-browser
 */

import { readFileSync, rmSync, statSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * How long a killed browser is given to actually exit before the launch proceeds.
 *
 * `kill()` only sends the signal — on Windows it is TerminateProcess, which is asynchronous —
 * and the browser may hold this profile's singleton lock for a while afterwards. Spawning
 * immediately meant the replacement saw a live instance, handed its command line over and
 * exited, and that exit was reported as a bad browser path.
 */
const EXIT_GRACE_MS = 3_000

/**
 * Ceiling on one attempt to ask a discovered CDP port who it is.
 *
 * The launch loop below polls: it reads `DevToolsActivePort`, tries `/json/version` on the port
 * inside it, and waits 250 ms between attempts under a 30 s deadline. An unbounded fetch can
 * park inside one iteration for the whole budget, so a bound is needed — but it has to be
 * small enough that the loop still behaves like a loop.
 *
 * The usual case is NOT a slow answer, it is NO answer: a browser that has written the file but
 * is not listening yet refuses the connection instantly, and that immediacy is what lets the
 * loop spin. Any timeout added here is paid on every iteration in which the port is not ready,
 * so an earlier attempt at this used 2000 ms — eight times the poll interval — and cut the
 * attempts available in the budget from roughly 120 to 15. This value is the same size as the
 * interval, so a worst-case iteration costs 500 ms and the budget still affords ~60 attempts.
 */
const PORT_PROBE_MS = 250

/**
 * Starts a browser process and returns a handle to it.
 *
 * Injectable so tests can supply something that speaks CDP — the seam a recovery test needs
 * and could not have while the launch was hardcoded to a stub that rejects Chromium's args.
 * @param path - the executable to run.
 * @param args - its arguments.
 * @returns the child process.
 */
export type BrowserLauncher = (path: string, args: readonly string[]) => ReturnType<typeof spawn>

/** The real launcher: spawn a detached-free child with pipes closed. */
const defaultLauncher: BrowserLauncher = (path, args) =>
  spawn(path, [...args], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: false })
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { BrowserError } from '../browser/types.js'
import type { ElectronBrowserViewHost, ElectronViewHandle } from './provider.js'

/** Which browser the user asked for. */
export type BrowserChannel = 'bundled' | 'chrome' | 'edge' | 'auto' | 'sidebar'

/** A resolved browser installation. */
export interface DetectedBrowser {
  /** Which product this is. */
  readonly kind: 'chrome' | 'edge' | 'brave'
  /** Absolute path to the executable. */
  readonly path: string
}

/**
 * Launcher names to look for on PATH, per product and per platform.
 *
 * The names genuinely differ: Linux distributions package the launcher under a
 * versioned name (`microsoft-edge-stable`, `google-chrome-stable`), Windows puts
 * `chrome.exe` in an Application directory that may or may not be on PATH, and macOS
 * ships the executable inside the .app bundle. PATH is still consulted first on every
 * platform — it is what reflects how the user actually installed the browser.
 */
const PATH_NAMES: Record<DetectedBrowser['kind'], Partial<Record<NodeJS.Platform, string[]>>> = {
  chrome: {
    win32: ['chrome'],
    darwin: ['Google Chrome', 'Chromium'],
    linux: ['google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'],
  },
  edge: {
    win32: ['msedge'],
    darwin: ['Microsoft Edge'],
    linux: ['microsoft-edge-stable', 'microsoft-edge', 'microsoft-edge-dev'],
  },
  brave: {
    win32: ['brave'],
    darwin: ['Brave Browser'],
    linux: ['brave-browser', 'brave'],
  },
}

/**
 * Where each product installs when its launcher is not on PATH.
 *
 * Windows keeps the executable inside a version-less Application directory; macOS
 * keeps it inside the .app bundle; Linux distributions that do not use a launcher
 * put it under /usr/bin or /opt. All are checked, and anything missed can be named
 * explicitly with DSH_BROWSER_<KIND>_PATH.
 */
const INSTALL_LOCATIONS: Record<DetectedBrowser['kind'], Partial<Record<NodeJS.Platform, string[]>>> = {
  chrome: {
    win32: [
      String.raw`C:\Program Files\Google\Chrome\Application\chrome.exe`,
      String.raw`C:\Program Files (x86)\Google\Chrome\Application\chrome.exe`,
      // Where a per-user install lands, which is what Chrome's own installer chooses when it
      // cannot (or should not) write to Program Files. Missing this meant the plugin reported
      // "no browser found" on machines that plainly had one.
      String.raw`%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe`,
      String.raw`%LOCALAPPDATA%\Chromium\Application\chrome.exe`,
    ],
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ],
    linux: [
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/opt/google/chrome/chrome',
      '/snap/bin/chromium',
    ],
  },
  edge: {
    win32: [
      String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
      String.raw`C:\Program Files\Microsoft\Edge\Application\msedge.exe`,
      String.raw`%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe`,
    ],
    darwin: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'],
    linux: [
      '/usr/bin/microsoft-edge-stable',
      '/usr/bin/microsoft-edge',
      '/usr/bin/microsoft-edge-dev',
    ],
  },
  brave: {
    win32: [
      String.raw`C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe`,
      String.raw`C:\Program Files (x86)\BraveSoftware\Brave-Browser\Application\brave.exe`,
      String.raw`%LOCALAPPDATA%\BraveSoftware\Brave-Browser\Application\brave.exe`,
    ],
    darwin: ['/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
    linux: ['/usr/bin/brave-browser', '/usr/bin/brave', '/snap/bin/brave'],
  },
}

/**
 * Resolve the environment references in one install location.
 *
 * The list is static strings, but a per-user install lands under %LOCALAPPDATA%, so the entry
 * has to be resolved against the environment detection was HANDED rather than process.env — a
 * caller that supplies a platform and an environment (which is what makes detection testable)
 * must not end up reading the developer's real machine.
 * @param location - one entry from the install-location table.
 * @param env - the environment to resolve against.
 * @returns the path with %NAME% references replaced, or the entry unchanged when unknown.
 */
function expandLocation(location: string, env: NodeJS.ProcessEnv): string {
  return location.replace(/%([^%]+)%/g, (whole, name: string) =>
    env[name] ?? env[name.toUpperCase()] ?? env[name.toLowerCase()] ?? whole)
}

/**
 * Find an executable by name on PATH.
 *
 * PATH is read from the supplied environment rather than the process's own, so the
 * detection stays testable. On Windows a bare name needs its extension; elsewhere
 * the launcher is the file itself.
 * @param names - candidate launcher names, in preference order.
 * @param env - the environment to read PATH from.
 * @param platform - the platform whose PATH and extension conventions apply.
 * @returns the first existing absolute path, or undefined.
 */
function findOnPath(names: readonly string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string | undefined {
  // Windows spells it Path as often as PATH; the separator differs too.
  const raw = env.PATH ?? env.Path ?? env.path ?? ''
  const separator = platform === 'win32' ? ';' : ':'
  const directories = raw.split(separator).map(entry => entry.trim()).filter(entry => entry !== '')
  const suffixes = platform === 'win32' ? ['.exe', '.cmd', ''] : ['']
  for (const name of names) {
    for (const directory of directories) {
      for (const suffix of suffixes) {
        const candidate = join(directory, `${name}${suffix}`)
        if (existsSync(candidate)) return candidate
      }
    }
  }
  return undefined
}

/**
 * Find an installed Chromium browser.
 *
 * `auto` prefers Chrome, then Edge, then Brave — the order reflects how likely each
 * is to be the browser a user actually chose rather than one the system shipped.
 * Each candidate is looked up in three places, most specific first: an explicit
 * environment override, then PATH, then the platform's conventional install
 * locations. PATH comes before the fixed paths because it is what actually reflects
 * how the browser was installed.
 * @param channel - the configured choice; `bundled` never resolves to a system browser.
 * @param env - environment lookup, injected so tests need no real machine.
 * @param platform - the platform to use conventions for; injected for the same reason.
 * @returns the detected browser, or undefined when the choice is unavailable.
 */
export function detectBrowser(
  channel: BrowserChannel,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): DetectedBrowser | undefined {
  if (channel === 'bundled') return undefined
  const order: DetectedBrowser['kind'][] = channel === 'auto' ? ['chrome', 'edge', 'brave'] : [channel as DetectedBrowser['kind']]
  for (const kind of order) {
    const fromEnv = (kind === 'chrome' ? env.DSH_BROWSER_CHROME_PATH : kind === 'edge' ? env.DSH_BROWSER_EDGE_PATH : undefined)
    if (fromEnv !== undefined && fromEnv !== '' && existsSync(fromEnv)) return { kind, path: fromEnv }
    const onPath = findOnPath(PATH_NAMES[kind]?.[platform] ?? [], env, platform)
    if (onPath !== undefined) return { kind, path: onPath }
    for (const raw of INSTALL_LOCATIONS[kind]?.[platform] ?? []) {
      const candidate = expandLocation(raw, env)
      if (existsSync(candidate)) return { kind, path: candidate }
    }
  }
  return undefined
}

/**
 * Everything that was checked for one product, for reporting a miss.
 *
 * Detection returns undefined with no explanation, which left the caller able to say
 * only "not found". This gives the user the actual list so they can see whether the
 * plugin looked somewhere their browser is not.
 * @param kind - the product to describe.
 * @param platform - the platform whose names and locations apply.
 * @returns the launcher names (as PATH lookups) and the fixed locations checked.
 */
export function searchSummary(
  kind: DetectedBrowser['kind'],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const onPath = (PATH_NAMES[kind]?.[platform] ?? []).map(name => `${name} (on PATH)`)
  // Expanded, so the report names the location that was actually tested rather than a template
  // the user cannot paste into a file manager.
  const located = (INSTALL_LOCATIONS[kind]?.[platform] ?? []).map(entry => expandLocation(entry, env))
  return [...onPath, ...located]
}

/**
 * Ceiling on one attempt to resolve an operator-set CDP endpoint.
 *
 * Unlike the launch loop's probe this happens once per connection rather than inside a poll, so
 * it can afford to wait for a slow answer — but not to hang: an address that swallows packets
 * has to fail while the operator is still looking at the call that triggered it.
 */
const ENDPOINT_PROBE_MS = 10_000

/**
 * The part of `fetch` the endpoint probe uses.
 *
 * Narrower than `fetch` on purpose: a caller may inject a stub that only has to answer with a
 * JSON body, which is how the endpoint rules are exercised with no browser anywhere.
 */
export type EndpointFetch = (url: string, init: { signal: AbortSignal }) => Promise<{ json(): Promise<unknown> }>

/**
 * A browser that is already running, named by the operator.
 *
 * The counterpart of {@link DetectedBrowser}: that one is an installation to start, this one is
 * a process to join.
 */
export interface CdpAttach {
  /**
   * The browser's CDP endpoint: its own `webSocketDebuggerUrl`
   * (`ws://host:port/devtools/browser/<id>`), or an `http(s)://host:port` origin, which is
   * resolved through `/json/version`.
   */
  readonly endpoint: string
  /** How to probe an http origin. Injected for tests; the global `fetch` otherwise. */
  readonly fetch?: EndpointFetch
}

/**
 * What a host drives: an installation to launch, or a running browser to attach to.
 *
 * The two are exclusive in the type rather than in a flag beside it, so "attaching spawns
 * nothing and claims no profile" is a property of what the object holds instead of a promise
 * about how it behaves.
 */
export type BrowserTarget = DetectedBrowser | CdpAttach

/** Whether a target names a browser to attach to, rather than one to launch. */
function isAttach(target: BrowserTarget): target is CdpAttach {
  return 'endpoint' in target
}

/**
 * The operator's CDP endpoint: the config field when it is set, otherwise
 * `DSH_BROWSER_CDP_ENDPOINT`.
 *
 * A blank value counts as absent on both sides. An empty config field outranking a real
 * environment variable would make the variable look broken, and a variable set to "" — which is
 * what `DSH_BROWSER_CDP_ENDPOINT=` leaves in the environment — must not read as an endpoint.
 * @param configured - the `cdpEndpoint` config field.
 * @param env - the environment to fall back to.
 * @returns the endpoint, or undefined when neither side sets one.
 */
export function cdpEndpointFrom(configured?: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  for (const candidate of [configured, env.DSH_BROWSER_CDP_ENDPOINT]) {
    if (candidate !== undefined && candidate.trim() !== '') return candidate.trim()
  }
  return undefined
}

/**
 * The WebSocket URL to speak CDP on, from an operator-set endpoint.
 *
 * A `ws://`/`wss://` URL already IS that URL. An `http://`/`https://` origin is the browser's
 * debugging port, and `/json/version` is where it publishes the URL to use instead. Anything
 * else is refused rather than guessed at: every guess picks a browser the operator did not name,
 * and naming one is the entire point of this setting.
 * @param endpoint - the configured endpoint.
 * @param fetchImpl - how to ask an http origin; injected for tests.
 * @returns the `webSocketDebuggerUrl` to connect to.
 */
export async function cdpEndpointUrl(endpoint: string, fetchImpl: EndpointFetch = fetch): Promise<string> {
  let parsed: URL
  try {
    parsed = new URL(endpoint.trim())
  } catch {
    throw cdpUnreachable(endpoint, 'it is not a URL')
  }
  if (parsed.protocol === 'ws:' || parsed.protocol === 'wss:') return endpoint.trim()
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw cdpUnreachable(endpoint, `its scheme (${parsed.protocol}) is neither ws:// nor http://`)
  }
  // A path on the origin is not part of the debugging protocol: /json/version hangs off the root.
  const versionUrl = new URL('/json/version', parsed).toString()
  let version: { webSocketDebuggerUrl?: unknown }
  try {
    version = await (await fetchImpl(versionUrl, { signal: AbortSignal.timeout(ENDPOINT_PROBE_MS) })).json() as { webSocketDebuggerUrl?: unknown }
  } catch (error) {
    throw cdpUnreachable(endpoint, `${versionUrl} did not answer: ${describeError(error)}`, error)
  }
  const socket = version?.webSocketDebuggerUrl
  if (typeof socket !== 'string' || socket === '') {
    throw cdpUnreachable(endpoint, `${versionUrl} reported no webSocketDebuggerUrl`)
  }
  return socket
}

/**
 * The one failure this mode has, named so a caller can act on it.
 *
 * Deliberately no second code for a typo and a dead address: both mean "nothing is reachable at
 * the endpoint you set", and the message says which one it looked like. The endpoint is always
 * in the message, because the value is configuration — its reader cannot see it from here.
 * @param endpoint - the endpoint that was tried.
 * @param why - what was wrong with it.
 * @param cause - the underlying failure, when there was one.
 * @returns the error to throw.
 */
function cdpUnreachable(endpoint: string, why: string, cause?: unknown): BrowserError {
  return new BrowserError(
    `browser: the CDP endpoint "${endpoint}" is unusable — ${why}. Nothing was launched: this `
    + 'deployment attaches to the browser it names (config cdpEndpoint / DSH_BROWSER_CDP_ENDPOINT), '
    + 'and falling back to a launch would drive a different browser than the one it asked for.',
    'BROWSER_CDP_ENDPOINT_UNREACHABLE',
    { cause },
  )
}

/** One error as a line of text, for a message that has to stay readable. */
function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** One CDP connection to a browser-level WebSocket, with flattened sessions. */
class CdpClient {
  private nextId = 1
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private readonly ready: Promise<void>

  /**
   * @param url - the browser's `webSocketDebuggerUrl`.
   */
  constructor(url: string) {
    // Node 22 provides WebSocket globally; no dependency is added for this.
    const socket = new WebSocket(url)
    this.socket = socket
    this.ready = new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve())
      socket.addEventListener('error', () => reject(new Error('dsh-builtin-browser: could not reach the browser over CDP')))
    })
    socket.addEventListener('message', event => this.onMessage(String((event as MessageEvent).data)))
    socket.addEventListener('close', () => this.fail(new Error('dsh-builtin-browser: the browser closed the CDP connection')))
  }

  private readonly socket: WebSocket

  /**
   * Resolve once the socket is open.
   *
   * Bounded on purpose. `ready` settles on the socket's own `open` or `error` events, and
   * a connection that is dropped by something in between may deliver neither — in which
   * case an unbounded await here would hang the tool call forever, because the caller's
   * own deadline is only checked between polls and this await happens inside one of them.
   * @returns when the handshake completed.
   */
  /**
   * Whether the socket is still usable.
   *
   * A dropped connection is not reported to the caller of send(); the pending command
   * would simply never complete. Asking the socket directly is what lets a cached client
   * be discarded instead of reused, which is the difference between a restart and a 30s
   * hang on every subsequent call.
   * @returns true while the socket is open.
   */
  isAlive(): boolean {
    return this.socket.readyState === WebSocket.OPEN
  }

  async whenReady(): Promise<void> {
    const timeoutMs = 30_000
    let timer: NodeJS.Timeout | undefined
    try {
      await Promise.race([
        this.ready,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`dsh-builtin-browser: the browser did not complete the CDP handshake within ${timeoutMs / 1000}s`)),
            timeoutMs,
          )
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * Send one CDP command, optionally on an attached session.
   * @param method - the CDP method.
   * @param params - its parameters.
   * @param sessionId - the flattened session to target, when this is a page command.
   * @returns the CDP result.
   */
  async send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown> {
    // Fail fast and say why. Waiting out the timeout on a closed socket produced
    // only "timed out", which reads as a slow page and hides the real cause.
    if (!this.isAlive()) {
      throw new Error('dsh-builtin-browser: the browser connection is closed (the browser window was probably closed); the next command will start it again')
    }
    await this.ready
    const id = this.nextId++
    const message = { id, method, ...params !== undefined ? { params } : {}, ...sessionId !== undefined ? { sessionId } : {} }
    return await new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify(message))
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`dsh-builtin-browser: ${method} timed out`))
      }, 30_000).unref?.()
    })
  }

  /** Close the socket. */
  close(): void {
    try { this.socket.close() } catch { /* already closed */ }
  }

  /** Route one CDP message to its waiter. */
  private onMessage(raw: string): void {
    let message: { id?: number; result?: unknown; error?: { message?: string } }
    try { message = JSON.parse(raw) } catch { return }
    if (message.id === undefined) return
    const entry = this.pending.get(message.id)
    if (entry === undefined) return
    this.pending.delete(message.id)
    if (message.error !== undefined) entry.reject(new Error(`dsh-builtin-browser: CDP error: ${message.error.message ?? 'unknown'}`))
    else entry.resolve(message.result)
  }

  /** Fail everything in flight. */
  private fail(error: Error): void {
    const pending = [...this.pending.values()]
    this.pending.clear()
    for (const entry of pending) entry.reject(error)
  }
}

/** A system browser driven over CDP, presented as a browser view host. */
export class SystemBrowserViewHost implements ElectronBrowserViewHost {
  /**
   * viewId -> the session that view rides, and the client that issued it.
   *
   * The client is part of the value on purpose. A session id means nothing to a browser other
   * than the one that handed it out, and this host replaces browsers routinely: the process
   * dies, or its debugging socket closes while the process lives on. Keeping only the id meant
   * the host could start a NEW browser successfully and then send every command to it carrying
   * a session the old one had issued — `Session with given id not found`, on every call, with a
   * browser that answers /json/version perfectly well and nothing the user can do short of
   * restarting DSH. Comparing identity catches it with no round trip; validating each cached
   * session against the browser would put one on every page command.
   */
  private readonly views = new Map<string, { session: string; client: CdpClient }>()
  private disposed = false
  /**
   * The browser is started on FIRST USE, never on construction.
   *
   * A plugin that launches Chrome the moment its host loads is a plugin that takes
   * over the machine before anyone asked it to: simply starting DSH would spawn a
   * browser window. Registration must therefore be inert, and the process is only
   * spawned when a view is actually needed.
   */
  private client: CdpClient | undefined
  /**
   * Set when a command went unanswered rather than being refused.
   *
   * A timeout says nothing about the connection: the page may simply be slow. It marks the
   * client for a cheap check before the next command trusts it, which keeps a slow page
   * from being mistaken for a dead browser while still catching one that has truly stopped
   * answering.
   */
  private clientSuspect = false
  private child: ChildProcess | undefined
  private starting: Promise<CdpClient> | undefined

  /**
   * Browsers that ignored a kill.
   *
   * They are no longer this host's child — a replacement has taken that slot — but they
   * are still running, still holding the profile, and still something release must try to
   * stop. Forgetting them is what allowed a launch this host could not undo.
   */
  private readonly stubborn: { kill: () => void; exitCode: number | null; signalCode: NodeJS.Signals | null }[] = []

  /**
   * @param browser - the detected installation to launch on first use, or the endpoint of a
   *   browser that is already running — which is then never launched, profiled or killed.
   * @param profileDir - a plugin-owned directory; the user's own profile is never touched.
   *   Unused in attach mode, which resolves no profile at all.
   * @param extraArgs - additional Chromium switches.
   * @param ephemeralDir - a directory to delete on release, when the user has turned
   *   persistence off so no login state outlives the session.
   * @param launcher - how to start the browser, for tests.
   *
   *   Recovery after the browser dies was untestable without this: the suite spawns a stub
   *   with Chromium's arguments, and a stub that is not a browser rejects them and exits, so
   *   no CDP endpoint ever appears and no session is ever created. Verified by mutation —
   *   removing every sessions.clear() left the recovery tests green. A launcher lets a test
   *   provide something that actually speaks CDP, so the state those tests describe exists.
   */
  constructor(
    private readonly browser: BrowserTarget,
    private readonly profileDir: string = '',
    private readonly extraArgs: readonly string[] = [],
    private readonly ephemeralDir?: string,
    private readonly launcher: BrowserLauncher = defaultLauncher,
  ) {
    this.ownsBrowser = !isAttach(browser)
  }

  /**
   * Whether this host owns the browser process it drives, and may therefore kill it.
   *
   * Attach mode is why this is a field and not a comment. The operator pointed us at a browser we
   * did not start — very possibly the one they are working in — so releasing this host closes our
   * connection to it and nothing else. Every path that ends a browser's life reads this flag
   * instead of re-deriving the answer, so the answer cannot drift away from the mode that set it.
   */
  readonly ownsBrowser: boolean

  /**
   * Build a host that ATTACHES to a browser already running at `endpoint`.
   *
   * The only way in: attach mode has no installation, no profile, no switches and no ephemeral
   * directory, so spelling it out as a constructor call would be a row of placeholders with one
   * real value among them — and a placeholder that later moves is how a launch sneaks back in.
   * @param endpoint - a `ws://` browser URL, or an `http://host:port` origin to resolve.
   * @param launcher - never called in this mode; injectable so a test can prove it stays uncalled.
   * @param fetchImpl - how to probe an http origin; injectable for the same reason.
   * @returns the host.
   */
  static attach(endpoint: string, launcher: BrowserLauncher = defaultLauncher, fetchImpl?: EndpointFetch): SystemBrowserViewHost {
    return new SystemBrowserViewHost({ endpoint, fetch: fetchImpl }, '', [], undefined, launcher)
  }

  /** Which product this host would drive (for diagnostics); undefined when it attaches. */
  get kind(): DetectedBrowser['kind'] | undefined {
    return isAttach(this.browser) ? undefined : this.browser.kind
  }

  /**
   * Whether the browser has actually been started yet (diagnostics and tests).
   *
   * Always false for a host that attaches: it starts nothing, it joins something.
   */
  get started(): boolean {
    return this.child !== undefined
  }

  /**
   * The CDP client, starting the browser on first use.
   * @returns the connected client.
   */
  /**
   * Whether a client that reports itself open is actually answering.
   *
   * An open socket proves nothing: a browser can hold the connection and never reply, and
   * that state must not be cached, or every later command waits out its own timeout. Asking
   * the browser something cheap is a fact; reading the failure text is a guess, and the
   * guess was wrong in both directions (it killed healthy browsers on a slow page, and it
   * mistook the browser's own free text for a verdict).
   *
   * This is only reached when the socket is open, so the common path costs nothing.
   * @param client - the client to question.
   * @returns true when it answered.
   */
  private async probeClient(client: CdpClient): Promise<boolean> {
    try {
      // The command budget (30s) on purpose, not a shorter "probe" value, because of what the
      // answer is used for: a false verdict discards the client and replaces the browser,
      // which KILLS the window the human is looking at. A page that is merely slow must not
      // lose its browser, so this errs toward waiting. The price is that a truly wedged
      // browser takes the full budget to be declared dead — the tool call that triggered the
      // probe answers first, and its timeout is the error the caller sees. Trading a later
      // error for a window that is not destroyed is the right way round.
      await client.send('Browser.getVersion', {})
      return true
    } catch {
      // No answer within the budget, or the socket failed while asking: unusable either way.
      return false
    }
  }

  /**
   * Forget which browser issued what, after that browser is gone.
   *
   * The two maps must move together: `views` maps a view id to a session id and `sessions`
   * maps a session id to a target id, so clearing one alone leaves a mapping the next command
   * will act on. Every path that abandons a browser calls this rather than spelling the pair
   * out — four separate copies is how the third one came to be missing.
   */
  private forgetBrowserState(): void {
    this.views.clear()
    this.sessions.clear()
  }

  private async ensureClient(): Promise<CdpClient> {
    // A disposed host must never start a browser: doing so would spawn a process
    // nobody owns and nobody will kill.
    if (this.disposed) throw new Error('dsh-builtin-browser: this browser host was released')
    // The exit listener clears this, but a socket can also die without the process doing so
    // (the browser closing its debugging endpoint, a dropped connection). Checking the
    // socket's own state costs nothing and turns a 30s hang into a restart.
    if (this.client !== undefined) {
      // A closed socket means the browser is gone; an OPEN socket proves nothing, because
      // a browser can hold the connection and never answer. Only probe when the socket is
      // closed or a previous command went unanswered without being refused — probing every
      // call would add a round trip to the common path for nothing.
      const current = this.client
      if (current.isAlive() && !this.clientSuspect) return current
      if (current.isAlive() && await this.probeClient(current)) {
        this.clientSuspect = false
        return current
      }
      current.close()
      this.client = undefined
      this.clientSuspect = false
      // Everything this client issued dies with it. `start()` clears these too, but only
      // inside its "kill the old child" branch — and the shape of this failure usually has no
      // child left to kill: the process already exited, its exit listener already set
      // `this.child` to undefined, so start() skips that branch and publishes a new browser
      // while the views still point at the dead one. That is the state that never recovers.
      this.forgetBrowserState()
    }
    // Concurrent first calls share one startup rather than racing two browsers.
    const attach = isAttach(this.browser) ? this.browser : undefined
    this.starting ??= (attach === undefined ? this.start() : this.attachTo(attach)).finally(() => { this.starting = undefined })
    return await this.starting
  }

  /**
   * Connect to the browser the operator named, instead of launching one.
   *
   * The endpoint is resolved on every (re)connect rather than remembered: a browser restarted
   * under the same address is picked up, and one that is gone fails HERE, naming the endpoint —
   * never by quietly launching a different browser to replace it.
   * @param attach - the browser to reach.
   * @returns the connected client.
   */
  private async attachTo(attach: CdpAttach): Promise<CdpClient> {
    const url = await cdpEndpointUrl(attach.endpoint, attach.fetch)
    const client = new CdpClient(url)
    try {
      // Bounded by `whenReady` itself, and reached only after the address answered (an http
      // origin) or was taken as given (a ws:// URL) — so this is a handshake, not a search.
      await client.whenReady()
    } catch (error) {
      client.close()
      throw cdpUnreachable(attach.endpoint, `${url} did not complete the CDP handshake (${describeError(error)})`, error)
    }
    // Released while the handshake was in flight. The connection is dropped because it is ours;
    // the browser is left alone because it is not.
    if (this.disposed) {
      client.close()
      throw new Error('dsh-builtin-browser: this browser host was released')
    }
    this.client = client
    return client
  }

  /**
   * Launch the browser with a private profile and connect over CDP.
   *
   * `--remote-debugging-port=0` plus the `DevToolsActivePort` file is the only
   * reliable way to learn the port: a fixed port collides with whatever else the
   * machine is running, and parsing stderr is fragile across versions.
   * @returns the connected client.
   */
  private async start(): Promise<CdpClient> {
    const browser = this.browser
    if (isAttach(browser)) {
      // Unreachable: ensureClient() only calls this for a launch target. Loud rather than silent,
      // because the alternative to throwing here is spawning a browser for a deployment that
      // asked to attach to one — the exact substitution this mode exists to prevent.
      throw new Error('dsh-builtin-browser: this host attaches to an existing browser; there is nothing to launch')
    }
    const args = [
      '--remote-debugging-port=0',
      `--user-data-dir=${this.profileDir}`,
      // Behave like a fresh, unattended browser: no first-run UI, no default-browser
      // prompt, no restore bubble, and no "Chrome is being controlled" infobar.
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter',
      '--disable-session-crashed-bubble',
      '--hide-crash-restore-bubble',
      ...this.extraArgs,
      'about:blank',
    ]
    // A browser from a previous attempt may still be running with this same
    // --user-data-dir. On Windows the new one would merely hand off to it and exit, and that
    // exit would then be treated as the launch failing.
    if (this.child !== undefined) {
      const dying = this.child
      try { dying.kill() } catch { /* already gone */ }
      this.child = undefined

      // Whatever the old browser issued is worthless now, and its exit listener cannot clean
      // up after itself: this.child is reassigned below, so the old child's exit event returns
      // early and the session ids it handed out would be reused against a browser that never
      // heard of them — the "Session with given id not found" loop, which never clears.
      this.client?.close()
      this.client = undefined
      this.forgetBrowserState()

      // Wait for it to actually die. kill() only sends the signal: on Windows it is
      // TerminateProcess, which is asynchronous, and the browser may still hold this profile's
      // singleton lock for a while. Spawning immediately meant the replacement saw an existing
      // instance, handed its command line over and exited — and that exit was then reported as
      // "check that the path is a runnable browser", blaming the user's install for a race this
      // code created. Bounded, because a process that refuses to die must not hang the call.
      await new Promise<void>(resolve => {
        if (dying.exitCode !== null || dying.signalCode !== null) { resolve(); return }
        const done = (): void => { clearTimeout(timer); resolve() }
        const timer = setTimeout(done, EXIT_GRACE_MS)
        dying.once('exit', done)
        // It did not exit in time. Dropping the reference here was how this host could
        // launch a browser it could never kill again: dispose() only knows about this.child,
        // and this process still holds the profile's singleton lock. Remember it so release
        // still reaches it.
        if (dying.exitCode === null && dying.signalCode === null) this.stubborn.push(dying)
        dying.once('exit', () => {
          const at2 = this.stubborn.indexOf(dying)
          if (at2 !== -1) this.stubborn.splice(at2, 1)
        })
      })
    }
    // The port file belongs to the browser that just died, and it is NOT removed when the
    // process is killed: nothing gives a terminated browser a chance to clean up. The launch
    // loop below reads it to learn the port, so a stale file means connecting to whatever else
    // holds that port — or to the previous instance — and publishing a client this host does
    // not own and dispose() can never kill.
    try { rmSync(join(this.profileDir, 'DevToolsActivePort'), { force: true }) } catch { /* nothing to remove */ }
    const spawnedAt = Date.now()
    let child: ReturnType<typeof spawn>
    try {
      child = this.launcher(browser.path, args)
    } catch (error) {
      // spawn throws synchronously for some targets (a .cmd on Windows, a path that cannot
      // be executed). Without this the exception escaped start() and skipped every
      // diagnostic below it.
      throw new Error(`dsh-builtin-browser: could not launch ${browser.path}: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.child = child
    /**
     * A launch that fails (ENOENT, no permission, a broken binary) is reported by an
     * asynchronous 'error' event on the child, NOT by a throw here and NOT by exitCode.
     * Without this listener Node treats it as unhandled and takes the whole host process
     * down — one bad browser path would kill DSH, not just fail a tool call.
     */
    let launchError: Error | undefined
    child.on('error', error => { launchError = error })
    // A browser that exits later is as unusable as one that never started, and the failure
    // has to reach the NEXT call rather than being swallowed: clearing the client here is
    // what makes ensureClient() start a fresh browser instead of returning a socket to a
    // dead process and letting every command time out.
    child.on('exit', () => {
      if (this.child !== child) return
      this.client?.close()
      this.client = undefined
      this.child = undefined
      // The pages this client opened belong to the process that just died; keeping their
      // session ids means every later command is sent to a browser that never issued them.
      // Clearing these is what makes the restart usable rather than merely alive.
      this.forgetBrowserState()
    })
    const portFile = join(this.profileDir, 'DevToolsActivePort')
    /**
     * The port this launch wrote, or undefined while it has not written one yet.
     *
     * A file left by the PREVIOUS browser is not evidence about this one. Its contents
     * name a port that may now belong to something else entirely — another Chromium, a
     * node --inspect — and connecting there publishes a client this host does not own and
     * dispose() can never kill. Only a file written after the spawn counts.
     */
    const freshPort = (): number | undefined => {
      try {
        if (!existsSync(portFile)) return undefined
        if (statSync(portFile).mtimeMs < spawnedAt) return undefined
        const value = Number(readFileSync(portFile, 'utf8').split('\n')[0]?.trim() ?? '')
        return Number.isInteger(value) && value > 0 ? value : undefined
      } catch {
        return undefined
      }
    }
    const deadline = Date.now() + 30_000
    /**
     * Why the loop stopped, so the failure can say what actually happened. Reporting
     * every ending as "did not expose CDP within 30s" was wrong three ways: the cause,
     * the words, and the elapsed time — a browser that cannot be launched says so in
     * half a second, and the caller then looks for a CDP problem that does not exist.
     */
    let stopped: 'released' | 'timeout' | 'exited' | 'launch-failed' = 'timeout'
    for (;;) {
      // Released while we were starting: stop here rather than keep polling for a
      // browser that dispose() has already killed, which would leave a connection
      // to a dead process behind. The child is killed here too — dispose() may have
      // run before this child was recorded, leaving nobody else to do it.
      if (this.disposed) { child.kill(); if (this.child === child) this.child = undefined; stopped = 'released'; break }
      if (launchError !== undefined) { if (this.child === child) this.child = undefined; stopped = 'launch-failed'; break }
      if (Date.now() > deadline) { child.kill(); if (this.child === child) this.child = undefined; stopped = 'timeout'; break }
      // signalCode too: a browser killed by a signal never sets exitCode, so checking exitCode
      // alone made a killed browser look alive and the launch run out its full 30s deadline
      // before reporting "did not expose CDP" — a timeout for something that died at once.
      // The sibling check on the release path already looked at both.
      if (child.exitCode !== null || child.signalCode !== null) { if (this.child === child) this.child = undefined; stopped = 'exited'; break }
      // Only a port THIS launch wrote: reading whatever file happened to be there is how a
          // restart could adopt the previous browser, or any process now holding that port.
          const port = freshPort()
          if (port !== undefined) {
        try {
            const version = await (await fetch(`http://127.0.0.1:${port}/json/version`, {
              // Bounded: an unanswered loopback request would otherwise park inside this
              // iteration for the rest of the budget, and the deadline above is only re-checked
              // between iterations. Deliberately no larger than the 250 ms sleep — see
              // PORT_PROBE_MS.
              signal: AbortSignal.timeout(PORT_PROBE_MS),
            })).json() as { webSocketDebuggerUrl?: string }
            if (typeof version.webSocketDebuggerUrl === 'string') {
              const client = new CdpClient(version.webSocketDebuggerUrl)
              // `whenReady` has its own 30 s ceiling, and it is reached only after the port
              // answered above — so the browser is listening and this is a handshake, not a
              // discovery. A handshake that outlives the launch is reported as the timeout it
              // is, by the same deadline that governs everything else here.
              await client.whenReady()
              // Still wanted? A dispose() during the handshake has already killed the
              // process, so publishing the client would leave a dangling connection.
              if (this.disposed) { client.close(); break }
              this.client = client
              return client
            }
        } catch {
          // The file can exist a moment before the port answers; poll again.
        }
      }
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    // Each ending gets its own message. The old single message blamed a CDP timeout for
    // all of them, which sent the reader looking for a port problem when the browser had
    // simply failed to launch.
    const target = `${browser.kind} (${browser.path})`
    if (stopped === 'launch-failed') {
      throw new Error(`dsh-builtin-browser: could not launch ${target}: ${launchError?.message ?? 'unknown error'}`)
    }
    if (stopped === 'exited') {
      // Only exit code 0 is the hand-off story. A non-zero code or a signal means the browser
      // died on its own — a crash, a missing library, a sandbox refusal — and asserting the
      // profile story for those sent people looking for a leftover process that was not there,
      // which is the same mistake this message was written to correct, pointing the other way.
      const code = child.exitCode
      const signal = child.signalCode
      const clean = code === 0 && signal === null
      throw new Error(
        clean
          ? `dsh-builtin-browser: ${target} exited immediately after launch (exit code 0). `
            + 'That means it handed the request to an instance already using this profile '
            + 'directory and quit — look for a leftover browser process from an earlier run, then retry.'
          : `dsh-builtin-browser: ${target} exited immediately after launch `
            + `(${signal !== null ? `killed by ${signal}` : `exit code ${String(code)}`}), so it did not `
            + 'hand the request anywhere — the browser failed to start rather than deferring to another '
            + 'instance. Check that it can run at all: run it by hand, and look for a crash or a missing '
            + 'dependency rather than a leftover process.',
      )
    }
    if (stopped === 'released') {
      throw new Error(`dsh-builtin-browser: ${target} was released while it was starting`)
    }
    throw new Error(`dsh-builtin-browser: ${target} did not expose CDP within 30s`)
  }

  /**
   * Whether this host can back views.
   *
   * True while the host is usable — including before the browser has been started,
   * since the first command is what starts it. Reporting "unavailable" here would
   * make the plugin fall back for no reason.
   */
  available(): boolean {
    return !this.disposed
  }

  createView(): ElectronViewHandle {
    const viewId = randomUUID()
    return {
      id: viewId,
      // This is the real browser, not Electron: CDP's JPEG encoder works here, so the
      // provider may pass format and quality through instead of falling back to PNG.
      supportsCdpJpeg: true,
      sendCommand: async (method: string, params?: Record<string, unknown>) => {
      // A command that never answered is the only signal that a client has wedged — the
      // socket can stay OPEN while nothing comes back, which is the form the reporter saw with
      // a live, healthy-looking Edge. Dropping the client here means the next call starts a new
      // browser rather than hanging again, and the error names the cause instead of a timeout.
      const client = await this.ensureClient()
      const cachedView = this.views.get(viewId)
      // A session belongs to the browser that issued it. Clearing the cache whenever a client is
      // dropped covers the ordinary case, but not this one: another call can be inside
      // ensureSession() holding the OLD client while this one discards it and clears, and that
      // call's `views.set` then lands afterwards — re-adding an entry naming a browser that is
      // gone. The identity check is what refuses it, and it costs a comparison rather than the
      // round trip that validating every cached session against the browser would cost.
      //
      // (Not covered by the tests: the race needs two interleaved commands, and the suite's fake
      // browser is synchronous enough that they never interleave. Verified by mutation instead —
      // removing this check alone leaves every case green, which is why the comment says what it
      // protects rather than claiming a case proves it.)
      const session = cachedView !== undefined && cachedView.client === client
        ? cachedView.session
        : await this.ensureSession(viewId)
      try {
        const result = await client.send(method, params, session)
        return (result ?? {}) as Record<string, unknown>
        } catch (error) {
          // A CDP protocol error means the browser ANSWERED and refused this one command, so the
          // connection is healthy and must be kept. Deciding by the error TEXT misfires both
          // ways: the inner timeout rejects with "… timed out", so a slow but healthy page read
          // as a dead browser, the client was dropped, and the next call's start() killed the
          // running child — the human's tabs and half-filled forms gone, which is worse than the
          // bug that change was fixing. The browser's own free text is interpolated into
          // protocol errors too, so any message containing those words misfired the same way.
          // Unanswered versus refused. 'timed out' is the inner client's own budget expiring,
          // which says the page was slow, not that the browser died — so it only marks the client
          // for a probe. Being wrong here costs a two-second check; being wrong about the
          // browser being dead cost the user their open tabs.
          if (error instanceof Error && /timed out/.test(error.message)) this.clientSuspect = true
          if (!client.isAlive()) {
            // Only THIS call's client. Under concurrency the field may already hold a
            // connection another call just published, and closing that would kill a healthy one.
            if (this.client === client) {
              this.client = undefined
              // This is the third of the three paths that discard a client, and it was the one
              // that did not retire what the client had issued. A view holding a session id
              // from the dead browser kept handing it to the replacement, which had never heard
              // of it: every page command then failed with "Session with given id not found"
              // and no later call could clear it, because the cached session was returned
              // unconditionally. Gated on the same identity check as the field itself, so a
              // concurrent call that just published a healthy client does not lose its maps.
              this.forgetBrowserState()
            }
            client.close()
          }
          throw error
      }
      },
    }
  }

  destroyView(handle: ElectronViewHandle): void {
    const cachedView = this.views.get(handle.id)
    this.views.delete(handle.id)
    if (cachedView === undefined) return
    const session = cachedView.session
    // A session id is not a target id: closing the page needs the target the session
    // was attached to, which is why they are tracked separately.
    const targetId = this.sessions.get(session)
    this.sessions.delete(session)
    // Nothing to close if the browser was never started.
    if (targetId !== undefined && this.client !== undefined) {
      // Best-effort: a page that is already gone is not an error.
      void this.client.send('Target.closeTarget', { targetId }).catch(() => undefined)
    }
  }

  /** Nothing to show: the browser owns its own windows. */
  showView(): void {}

  /**
   * Bring the target's page to the front, then report success.
   *
   * The comment on `focus` below used to say this was impossible — that raising the page needs
   * `Page.bringToFront` on a target session, which is a view-level concern the host cannot
   * reach. The handle this method is handed IS that view, and it can send commands, so the
   * capability was here all along; it just was not used. Without it `presentView` was an empty
   * async method, so the provider's whole presentation barrier — the one that stops
   * `Input.*` from being silently dropped for a view with no display surface, and reports
   * `BROWSER_VIEW_NOT_PRESENTED` when it cannot present — never ran on this carrier.
   *
   * A failure is swallowed rather than propagated: a real Chrome window that refuses to come
   * forward is not a reason to refuse the click that follows. The barrier exists to order the
   * two, and the order is honoured either way.
   * @param handle - the view to present.
   */
  async presentView(handle: ElectronViewHandle): Promise<void> {
    try {
      await handle.sendCommand('Page.bringToFront')
    } catch {
      // Backgrounded, minimised, or a target that went away between the snapshot and the
      // click. The command that called this will report its own failure if the page is gone.
    }
  }



  /**
   * Best effort at bringing the browser's window forward.
   *
   * The browser is a separate application, so there is no view to raise. What this can
   * actually do is ask its process to continue from a stopped state — which is a no-op on
   * Windows, where `SIGCONT` is not a supported signal and the call throws. It is kept
   * because it costs nothing and does help on POSIX (a process stopped with SIGSTOP
   * resumes), but it must not be read as a promise that the window comes to the front;
   * importantly, it does NOT raise a window that is merely behind another. Raising the
   * page properly would need `Page.bringToFront` on a specific target session, which is a
   * view-level concern and not available to the host.
   */
  async focus(): Promise<void> {
    try { this.child?.kill('SIGCONT') } catch { /* Windows has no SIGCONT; nothing to do */ }
  }



  /**
   * Close the browser we launched, if we ever launched one.
   *
   * The user's own windows belong to a different process and are never touched. A
   * host whose browser was never started (the common case when nobody used the
   * browser) simply tears down its bookkeeping.
   *
   * A host that ATTACHED never launched anything, so release stops at closing its own
   * connection: the browser it was driving outlives this plugin, which is the whole point of
   * pointing it at one that already existed. `ownsBrowser` is what decides that — not whether a
   * child happens to be recorded, which is a fact about the launch path rather than about who
   * the process belongs to.
   *
   * (The gate is not observable from the attach side, and the tests say so: an attached host
   * never records a child, so removing the check altogether changes nothing a test can see —
   * verified by mutation, which is why this is written as an invariant of the mode rather than
   * as a case it proves. What the tests do decide is both directions of the flag itself: true
   * kills the browser this host started, false leaves the one it did not start alone.)
   */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.forgetBrowserState()
    this.client?.close()
    if (this.ownsBrowser) {
      try { this.child?.kill() } catch { /* already gone */ }
      // And anything that ignored an earlier kill. They hold this profile, so leaving them
      // running means the next launch contends with a browser nobody owns.
      for (const leftover of this.stubborn.splice(0)) {
        try { leftover.kill() } catch { /* already gone */ }
      }
    }
    const ephemeral = this.ephemeralDir
    if (ephemeral !== undefined && this.child !== undefined) {
      // The browser flushes its profile while shutting down, so deleting later avoids
      // racing it. Leftovers are only a stray temp directory, never a live credential.
      //
      // The timer is unref'd, so it never holds the process open — which also means that a
      // process which exits inside this 3s window (a CLI probe, a DSH restart) leaves the
      // directory behind for good, silently contradicting the user's "keep no profile"
      // choice. The exit hook below is the same delete, run synchronously as a last resort;
      // the callback is idempotent, so whichever runs first wins and the other is a no-op.
      const removeEphemeral = (): void => {
        try { rmSync(ephemeral, { recursive: true, force: true }) } catch { /* best effort */ }
      }
      setTimeout(removeEphemeral, 3_000).unref?.()
      process.once('exit', removeEphemeral)
    } else if (ephemeral !== undefined) {
      // Never started, so nothing can be holding it open.
      try { rmSync(ephemeral, { recursive: true, force: true }) } catch { /* best effort */ }
    }
  }

  /**
   * The flattened session for a view, creating its page on first use.
   *
   * No cache check here: the only caller has already established that the cached session does
   * not belong to the client it is about to use. Re-checking would mean either a round trip or
   * a second copy of that rule.
   */
  private async ensureSession(viewId: string): Promise<string> {
    // One target per view, even when two commands arrive together. The two CDP round trips
    // below are awaits, so without this a second caller entering during the first's flight saw
    // no session in `views` and created its own target — leaving an orphan page that nothing
    // closes, because only the last id survives in the map.
    const inFlight = this.sessionBuilding.get(viewId)
    if (inFlight !== undefined) return await inFlight
    const building = this.buildSession(viewId).finally(() => {
      this.sessionBuilding.delete(viewId)
    })
    this.sessionBuilding.set(viewId, building)
    return await building
  }

  /** Create and attach the target for one view. Serialised by {@link ensureSession}. */
  private async buildSession(viewId: string): Promise<string> {
    const client = await this.ensureClient()
    const created = await client.send('Target.createTarget', { url: 'about:blank' }) as { targetId?: string }
    const targetId = created?.targetId
    if (typeof targetId !== 'string') throw new Error('dsh-builtin-browser: the browser did not create a page')
    const attached = await client.send('Target.attachToTarget', { targetId, flatten: true }) as { sessionId?: string }
    const sessionId = attached?.sessionId
    if (typeof sessionId !== 'string') throw new Error('dsh-builtin-browser: the browser did not attach to the new page')
    // The session id is what page commands ride; the target id is what closes it.
    this.sessions.set(sessionId, targetId)
    this.views.set(viewId, { session: sessionId, client })
    return sessionId
  }

  /** Views whose session is being created right now, so a second caller waits for the first. */
  private readonly sessionBuilding = new Map<string, Promise<string>>()

  /** sessionId -> targetId, so a destroyed view can close the right page. */
  private readonly sessions = new Map<string, string>()
}
