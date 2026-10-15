/**
 * Print the active tab to a PDF file.
 *
 * `Page.printToPDF` is a plain request/response CDP call, so this needs none of the event
 * plumbing the other features use: the page is rendered by Chromium's own print pipeline and
 * the reply carries the document as base64.
 *
 * @module dsh-builtin-browser/browser-electron/features/pdf
 */
import type { BrowserPdfRequest, BrowserPdfResult } from '../../browser/types.js';
import { type FeatureDeps } from './deps.js';
/**
 * Print the page behind `viewId` to `request.savePath`.
 * @param deps - the provider primitives (send, admit, writeFile).
 * @param viewId - the backing view of the session's active tab.
 * @param request - what to print and where to put it.
 * @returns the written path and its size.
 */
export declare function printToPdf(deps: FeatureDeps, viewId: string, request: BrowserPdfRequest): Promise<BrowserPdfResult>;
