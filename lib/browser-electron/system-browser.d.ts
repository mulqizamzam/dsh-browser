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
/**
 * Starts a browser process and returns a handle to it.
 *
 * Injectable so tests can supply something that speaks CDP — the seam a recovery test needs
 * and could not have while the launch was hardcoded to a stub that rejects Chromium's args.
 * @param path - the executable to run.
 * @param args - its arguments.
 * @returns the child process.
 */
export type BrowserLauncher = (path: string, args: readonly string[]) => ReturnType<typeof spawn>;
import { spawn } from 'node:child_process';
import type { ElectronBrowserViewHost, ElectronViewHandle } from './provider.js';
/** Which browser the user asked for. */
export type BrowserChannel = 'bundled' | 'chrome' | 'edge' | 'auto' | 'sidebar';
/** A resolved browser installation. */
export interface DetectedBrowser {
    /** Which product this is. */
    readonly kind: 'chrome' | 'edge' | 'brave';
    /** Absolute path to the executable. */
    readonly path: string;
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
export declare function detectBrowser(channel: BrowserChannel, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): DetectedBrowser | undefined;
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
export declare function searchSummary(kind: DetectedBrowser['kind'], platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv): string[];
/**
 * The part of `fetch` the endpoint probe uses.
 *
 * Narrower than `fetch` on purpose: a caller may inject a stub that only has to answer with a
 * JSON body, which is how the endpoint rules are exercised with no browser anywhere.
 */
export type EndpointFetch = (url: string, init: {
    signal: AbortSignal;
}) => Promise<{
    json(): Promise<unknown>;
}>;
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
    readonly endpoint: string;
    /** How to probe an http origin. Injected for tests; the global `fetch` otherwise. */
    readonly fetch?: EndpointFetch;
}
/**
 * What a host drives: an installation to launch, or a running browser to attach to.
 *
 * The two are exclusive in the type rather than in a flag beside it, so "attaching spawns
 * nothing and claims no profile" is a property of what the object holds instead of a promise
 * about how it behaves.
 */
export type BrowserTarget = DetectedBrowser | CdpAttach;
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
export declare function cdpEndpointFrom(configured?: string, env?: NodeJS.ProcessEnv): string | undefined;
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
export declare function cdpEndpointUrl(endpoint: string, fetchImpl?: EndpointFetch): Promise<string>;
/** A system browser driven over CDP, presented as a browser view host. */
export declare class SystemBrowserViewHost implements ElectronBrowserViewHost {
    private readonly browser;
    private readonly profileDir;
    private readonly extraArgs;
    private readonly ephemeralDir?;
    private readonly launcher;
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
    private readonly views;
    private disposed;
    /**
     * The browser is started on FIRST USE, never on construction.
     *
     * A plugin that launches Chrome the moment its host loads is a plugin that takes
     * over the machine before anyone asked it to: simply starting DSH would spawn a
     * browser window. Registration must therefore be inert, and the process is only
     * spawned when a view is actually needed.
     */
    private client;
    /**
     * Set when a command went unanswered rather than being refused.
     *
     * A timeout says nothing about the connection: the page may simply be slow. It marks the
     * client for a cheap check before the next command trusts it, which keeps a slow page
     * from being mistaken for a dead browser while still catching one that has truly stopped
     * answering.
     */
    private clientSuspect;
    private child;
    private starting;
    /**
     * Browsers that ignored a kill.
     *
     * They are no longer this host's child — a replacement has taken that slot — but they
     * are still running, still holding the profile, and still something release must try to
     * stop. Forgetting them is what allowed a launch this host could not undo.
     */
    private readonly stubborn;
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
    constructor(browser: BrowserTarget, profileDir?: string, extraArgs?: readonly string[], ephemeralDir?: string | undefined, launcher?: BrowserLauncher);
    /**
     * Whether this host owns the browser process it drives, and may therefore kill it.
     *
     * Attach mode is why this is a field and not a comment. The operator pointed us at a browser we
     * did not start — very possibly the one they are working in — so releasing this host closes our
     * connection to it and nothing else. Every path that ends a browser's life reads this flag
     * instead of re-deriving the answer, so the answer cannot drift away from the mode that set it.
     */
    readonly ownsBrowser: boolean;
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
    static attach(endpoint: string, launcher?: BrowserLauncher, fetchImpl?: EndpointFetch): SystemBrowserViewHost;
    /** Which product this host would drive (for diagnostics); undefined when it attaches. */
    get kind(): DetectedBrowser['kind'] | undefined;
    /**
     * Whether the browser has actually been started yet (diagnostics and tests).
     *
     * Always false for a host that attaches: it starts nothing, it joins something.
     */
    get started(): boolean;
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
    private probeClient;
    /**
     * Forget which browser issued what, after that browser is gone.
     *
     * The two maps must move together: `views` maps a view id to a session id and `sessions`
     * maps a session id to a target id, so clearing one alone leaves a mapping the next command
     * will act on. Every path that abandons a browser calls this rather than spelling the pair
     * out — four separate copies is how the third one came to be missing.
     */
    private forgetBrowserState;
    private ensureClient;
    /**
     * Connect to the browser the operator named, instead of launching one.
     *
     * The endpoint is resolved on every (re)connect rather than remembered: a browser restarted
     * under the same address is picked up, and one that is gone fails HERE, naming the endpoint —
     * never by quietly launching a different browser to replace it.
     * @param attach - the browser to reach.
     * @returns the connected client.
     */
    private attachTo;
    /**
     * Launch the browser with a private profile and connect over CDP.
     *
     * `--remote-debugging-port=0` plus the `DevToolsActivePort` file is the only
     * reliable way to learn the port: a fixed port collides with whatever else the
     * machine is running, and parsing stderr is fragile across versions.
     * @returns the connected client.
     */
    private start;
    /**
     * Whether this host can back views.
     *
     * True while the host is usable — including before the browser has been started,
     * since the first command is what starts it. Reporting "unavailable" here would
     * make the plugin fall back for no reason.
     */
    available(): boolean;
    createView(): ElectronViewHandle;
    destroyView(handle: ElectronViewHandle): void;
    /** Nothing to show: the browser owns its own windows. */
    showView(): void;
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
    presentView(handle: ElectronViewHandle): Promise<void>;
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
    focus(): Promise<void>;
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
    dispose(): void;
    /**
     * The flattened session for a view, creating its page on first use.
     *
     * No cache check here: the only caller has already established that the cached session does
     * not belong to the client it is about to use. Re-checking would mean either a round trip or
     * a second copy of that rule.
     */
    private ensureSession;
    /** Create and attach the target for one view. Serialised by {@link ensureSession}. */
    private buildSession;
    /** Views whose session is being created right now, so a second caller waits for the first. */
    private readonly sessionBuilding;
    /** sessionId -> targetId, so a destroyed view can close the right page. */
    private readonly sessions;
}
