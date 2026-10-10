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
/** A running Xvfb, with the DISPLAY string the child should use. */
export interface VirtualDisplay {
    /** The display string to pass as DISPLAY, e.g. `:90`. */
    readonly display: string;
    /** Stop the server. Idempotent; safe to call more than once. */
    kill(): void;
}
/**
 * Pure decision: does this environment need a virtual display?
 *
 * True only on Linux with neither DISPLAY nor WAYLAND_DISPLAY set. An empty
 * string counts as unset — `DISPLAY=` in a broken profile is the same
 * headless machine as no variable at all.
 */
export declare function needsVirtualDisplay(platform: NodeJS.Platform, display: string | undefined, waylandDisplay: string | undefined): boolean;
/**
 * Locate the Xvfb binary: the PATH, then the fixed locations Debian, Ubuntu
 * and Fedora install it to. Pure over its input (the PATH string), so the
 * fallback list is what a test sees.
 */
export declare function findXvfbBinary(pathEnv: string | undefined): string | undefined;
/**
 * Display numbers already taken: a socket in the X11 socket directory or a
 * stale lock file in the temp directory both mean "do not try this one".
 */
export declare function takenDisplayNumbers(socketDir: string, lockDir: string): number[];
/**
 * First free display number in [min, max], or undefined when all are taken.
 * Pure: the caller observes the filesystem, this only selects.
 */
export declare function pickDisplayNumber(taken: readonly number[], min?: number, max?: number): number | undefined;
/**
 * Start Xvfb on a free display number and wait until its socket exists.
 *
 * Rejects — rather than falling back to a displayless spawn — when Xvfb is
 * missing or no display number is free: the caller's spawn would then die with
 * the same SIGTRAP this exists to prevent, and a silent fallback would hide a
 * diagnosable environment problem behind a crash loop.
 */
export declare function startVirtualDisplay(): Promise<VirtualDisplay>;
