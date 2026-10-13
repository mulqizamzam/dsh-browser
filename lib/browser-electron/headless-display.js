/**
 * Headless display supervision (Linux).
 *
 * The self-hosted browser host is a real Electron app, and Electron's UI
 * platform needs an X server (or a Wayland compositor): without one it dies
 * before any of this plugin's code runs, with
 *
 *   ERROR:ui/ozone/platform/x11/ozone_platform_x11.cc Missing X server or $DISPLAY
 *   ERROR:ui/aura/env.cc The platform failed to initialize. Exiting.
 *
 * and a SIGTRAP the parent can only report as "browser host exited
 * (signal=SIGTRAP)". That is the whole failure this module closes: a headless
 * machine (a server, a container — anywhere DSH runs without a desktop) now
 * gets a virtual X server, started per child and torn down with it, instead of
 * a crash loop.
 *
 * The virtual display is never a rewrite of the display environment: an
 * operator who already has DISPLAY or WAYLAND_DISPLAY set keeps using their
 * real one, and nothing here touches a non-Linux platform (macOS and Windows
 * always have a display server as far as Electron is concerned).
 *
 * Xvfb is an environment prerequisite, not a dependency — it ships with the
 * `xvfb` package on Debian/Ubuntu and `xorg-server-xvfb` on Fedora. When it is
 * absent the host fails exactly as before, and the log line written here says
 * which package to install.
 * @module dsh-browser/browser-electron/headless-display
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
/** Lowest display number this module will pick (never steals :0). */
const MIN_DISPLAY_NUMBER = 90;
/** Highest display number this module will pick before giving up. */
const MAX_DISPLAY_NUMBER = 199;
/** Screen geometry of the virtual display: the child's windows are 1400x900. */
const SCREEN_GEOMETRY = '1920x1080x24';
/** How long Xvfb gets to create its socket before the start is abandoned. */
const XVFB_READY_TIMEOUT_MS = 10_000;
/**
 * Pure decision: does this environment need a virtual display?
 *
 * True only on Linux with neither DISPLAY nor WAYLAND_DISPLAY set. An empty
 * string counts as unset — `DISPLAY=` in a broken profile is the same
 * headless machine as no variable at all.
 */
export function needsVirtualDisplay(platform, display, waylandDisplay) {
    if (platform !== 'linux')
        return false;
    const hasDisplay = typeof display === 'string' && display.trim() !== '';
    const hasWayland = typeof waylandDisplay === 'string' && waylandDisplay.trim() !== '';
    return !hasDisplay && !hasWayland;
}
/**
 * Locate the Xvfb binary: the PATH, then the fixed locations Debian, Ubuntu
 * and Fedora install it to. Pure over its input (the PATH string), so the
 * fallback list is what a test sees.
 */
export function findXvfbBinary(pathEnv) {
    const entries = typeof pathEnv === 'string' ? pathEnv.split(delimiter).filter(Boolean) : [];
    for (const entry of entries) {
        const candidate = join(entry, 'Xvfb');
        if (existsSync(candidate))
            return candidate;
    }
    for (const candidate of ['/usr/bin/Xvfb', '/usr/local/bin/Xvfb', '/bin/Xvfb']) {
        if (existsSync(candidate))
            return candidate;
    }
    return undefined;
}
/**
 * Display numbers already taken: a socket in the X11 socket directory or a
 * stale lock file in the temp directory both mean "do not try this one".
 */
export function takenDisplayNumbers(socketDir, lockDir) {
    const taken = new Set();
    try {
        for (const name of readdirSync(socketDir)) {
            const match = /^X(\d+)$/.exec(name);
            if (match)
                taken.add(Number(match[1]));
        }
    }
    catch { /* no socket directory: nothing taken there */ }
    try {
        for (const name of readdirSync(lockDir)) {
            const match = /^\.X(\d+)-lock$/.exec(name);
            if (match)
                taken.add(Number(match[1]));
        }
    }
    catch { /* unreadable temp directory: nothing taken there */ }
    return [...taken];
}
/**
 * First free display number in [min, max], or undefined when all are taken.
 * Pure: the caller observes the filesystem, this only selects.
 */
export function pickDisplayNumber(taken, min = MIN_DISPLAY_NUMBER, max = MAX_DISPLAY_NUMBER) {
    const used = new Set(taken);
    for (let n = min; n <= max; n++) {
        if (!used.has(n))
            return n;
    }
    return undefined;
}
/**
 * Display numbers another mount namespace already owns.
 *
 * `takenDisplayNumbers` above reads THIS namespace's /tmp. A container — or
 * the DSH tool sandbox, which hands every process a private /tmp — cannot see
 * the host browser's sockets and lock files, so the picker would hand out a
 * display the host is already serving and Xvfb would die binding it. Every X
 * server also listens on an ABSTRACT socket, `@/tmp/.X11-unix/X<n>`, which
 * lives in the network namespace instead, and `/proc/net/unix` lists them all
 * regardless of mount namespace. Reading it makes the collision visible.
 *
 * Pure over its input, like its sibling above: an unreadable /proc yields no
 * numbers and never an error, so a platform without that file keeps the
 * previous behaviour exactly.
 */
export function abstractDisplayNumbers(procNetUnix = '/proc/net/unix') {
    let text;
    try {
        text = readFileSync(procNetUnix, 'utf8');
    }
    catch {
        return [];
    }
    const taken = new Set();
    for (const match of text.matchAll(/\/tmp\/\.X11-unix\/X(\d+)/g)) {
        taken.add(Number(match[1]));
    }
    return [...taken].sort((a, b) => a - b);
}
/**
 * Start Xvfb on a free display number and wait until its socket exists.
 *
 * Rejects — rather than falling back to a displayless spawn — when Xvfb is
 * missing or no display number is free: the caller's spawn would then die with
 * the same SIGTRAP this exists to prevent, and a silent fallback would hide a
 * diagnosable environment problem behind a crash loop.
 */
export async function startVirtualDisplay(socketDir = join(tmpdir(), '.X11-unix'), lockDir = tmpdir(), procNetUnix = '/proc/net/unix') {
    const binary = findXvfbBinary(process.env.PATH);
    if (binary === undefined) {
        throw new Error('headless system without an X server: install Xvfb (Debian/Ubuntu: `apt install xvfb`;'
            + ' Fedora: `dnf install xorg-server-xvfb`) or set DISPLAY to a running X server');
    }
    // Two views of "taken": the files this namespace can see, and the abstract
    // sockets every namespace shares. Using only the first is how the picker
    // once handed out the host browser's own display.
    const taken = [
        ...takenDisplayNumbers(socketDir, lockDir),
        ...abstractDisplayNumbers(procNetUnix),
    ];
    const number = pickDisplayNumber(taken);
    if (number === undefined) {
        throw new Error(`no free X display number in ${String(MIN_DISPLAY_NUMBER)}..${String(MAX_DISPLAY_NUMBER)}`);
    }
    const display = `:${String(number)}`;
    const socketPath = join(tmpdir(), '.X11-unix', `X${String(number)}`);
    const proc = spawn(binary, [display, '-screen', '0', SCREEN_GEOMETRY, '-nolisten', 'tcp', '-noreset'], {
        stdio: 'ignore',
    });
    let killed = false;
    const kill = () => {
        if (killed)
            return;
        killed = true;
        try {
            proc.kill('SIGTERM');
        }
        catch { /* already gone */ }
    };
    await new Promise((resolve, reject) => {
        const deadline = Date.now() + XVFB_READY_TIMEOUT_MS;
        const poll = () => {
            if (killed) {
                reject(new Error('virtual display stopped before it became ready'));
                return;
            }
            if (existsSync(socketPath)) {
                resolve();
                return;
            }
            if (Date.now() > deadline) {
                reject(new Error(`Xvfb did not create ${socketPath} within ${String(XVFB_READY_TIMEOUT_MS)}ms`));
                return;
            }
            setTimeout(poll, 50);
        };
        poll();
        // A binary that dies immediately (bad flags, missing libs) must not be
        // waited out to the deadline: the exit listener turns it into a named
        // failure, and the display is killed so no half-server is left behind.
        proc.once('exit', (code, signal) => {
            reject(new Error(`Xvfb exited before becoming ready (code=${String(code)} signal=${String(signal)})`));
        });
    }).catch(error => {
        kill();
        throw error;
    });
    return { display, kill };
}
