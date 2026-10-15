/**
 * Record the active tab as a video file.
 *
 * CONTRACT (implemented in this file)
 *  - `action: 'start'` subscribes the `Page` domain (`deps.subscribe(viewId, ['Page'])`) and
 *    issues `Page.startScreencast` with the requested format/quality/size. Every
 *    `Page.screencastFrame` is acknowledged IMMEDIATELY with `Page.screencastFrameAck` (CDP
 *    stops sending frames until it is acked) and its JPEG/PNG bytes are buffered with a
 *    timestamp. The listener runs on the socket's data path: it may not await, so the ack is
 *    fired without blocking and failures are counted, not thrown.
 *  - `action: 'stop'` issues `Page.stopScreencast`, unsubscribes nothing (the domain set is
 *    the provider's business), asks `deps.ffmpegPath()` for an encoder and writes the frames
 *    to `request.savePath` (required, admitted with `deps.admit(..., 'video')`).
 *  - Encoding: frames are piped to ffmpeg (`-f image2pipe -framerate <captured> -i - -c:v
 *    libx264 -pix_fmt yuv420p -r <fps>`) through `spawn`, stdin closed after the last frame.
 *    No ffmpeg → a clear `BROWSER_VIDEO_NO_FFMPEG` error that names the fact; the frames are
 *    still discarded, never silently reported as a recording.
 *  - Caps: at most `maxFrames` (default 600) buffered frames and 512 MiB of frame bytes; past
 *    either, further frames are dropped and counted as `droppedFrames`. A `stop` with no
 *    recording in flight is `BROWSER_VIDEO_NOT_STARTED`.
 *
 * Notes on choices this file makes (the contract leaves them open):
 *  - The listener is attached BEFORE `Page.startScreencast` is sent. Frames start arriving the
 *    moment that command lands, so a listener attached afterwards loses the head of the take.
 *  - A `stop` that fails after admission has already torn the screencast down: the buffer is
 *    single-use, because a recording that could not be encoded is not a recording, and holding
 *    up to half a gigabyte per view for a retry that can never be encoded is a leak.
 *  - The encoder is resolved BEFORE the buffered frames are counted. No ffmpeg is a machine
 *    fact the operator has to fix either way, and it is the failure the contract singles out;
 *    with frames captured but no encoder there is no file to write under any circumstance.
 *  - A non-zero ffmpeg exit removes the partial file it left behind. `admit` guarantees the
 *    path was free, so whatever is there is ours, and a truncated .mp4 that a caller might
 *    later play is worse than no file at all.
 *
 * @module dsh-builtin-browser/browser-electron/features/video
 */
import type { BrowserVideoRequest, BrowserVideoResult } from '../../browser/types.js';
import { type FeatureDeps } from './deps.js';
/**
 * Start or stop a screen recording of the view behind `viewId`.
 * @param deps - the provider primitives.
 * @param viewId - the backing view of the session's active tab.
 * @param request - `start` or `stop`, plus encoding options.
 * @returns whether a recording is now active, and for a stop the written path and frame count.
 */
export declare function controlVideo(deps: FeatureDeps, viewId: string, request: BrowserVideoRequest): Promise<BrowserVideoResult>;
/**
 * Drop whatever a destroyed view left behind.
 *
 * A recording holds every captured frame in memory until it is stopped, and its listener keeps
 * that closure alive; a view destroyed mid-recording would otherwise hold both until the
 * process exits. The provider calls this when a session or tab goes away.
 * @param viewId - the view that no longer exists.
 */
export declare function releaseVideoView(viewId: string): void;
