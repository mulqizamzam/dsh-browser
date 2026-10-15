/**
 * Print the active tab to a PDF file.
 *
 * `Page.printToPDF` is a plain request/response CDP call, so this needs none of the event
 * plumbing the other features use: the page is rendered by Chromium's own print pipeline and
 * the reply carries the document as base64.
 *
 * @module dsh-builtin-browser/browser-electron/features/pdf
 */

import { BrowserError } from '../../browser/types.js'
import type { BrowserPdfRequest, BrowserPdfResult } from '../../browser/types.js'
import { withTimeout, type FeatureDeps } from './deps.js'

/**
 * Refuse a document larger than this. Chromium will happily build a multi-hundred-megabyte PDF
 * from a pathological page, and the whole thing has to cross the RPC reply as base64 — a cap
 * with a named error is better than a memory spike in two processes.
 */
const MAX_PDF_BYTES = 64 * 1024 * 1024

/** CDP's way of saying this debugger does not implement the method at all. */
const METHOD_NOT_IMPLEMENTED = /wasn't found|not found|not supported|is not available|unknown method/i

/** Page rendering plus PDF assembly; the tool's own budget is larger than this. */
const PDF_TIMEOUT_MS = 45_000

/**
 * Print the page behind `viewId` to `request.savePath`.
 * @param deps - the provider primitives (send, admit, writeFile).
 * @param viewId - the backing view of the session's active tab.
 * @param request - what to print and where to put it.
 * @returns the written path and its size.
 */
export async function printToPdf(deps: FeatureDeps, viewId: string, request: BrowserPdfRequest): Promise<BrowserPdfResult> {
  // Admit BEFORE rendering: a refused path must not cost a page render, and the destination
  // is the part the caller can actually fix.
  const target = deps.admit(request.savePath, 'pdf')
  const params: Record<string, unknown> = {
    // Backgrounds off by default would surprise anyone printing a designed page; the flag is
    // the caller's to turn off.
    printBackground: request.printBackground ?? true,
    ...request.landscape !== undefined ? { landscape: request.landscape } : {},
    ...request.paperWidth !== undefined ? { paperWidth: request.paperWidth } : {},
    ...request.paperHeight !== undefined ? { paperHeight: request.paperHeight } : {},
    ...request.marginTop !== undefined ? { marginTop: request.marginTop } : {},
    ...request.marginBottom !== undefined ? { marginBottom: request.marginBottom } : {},
    ...request.marginLeft !== undefined ? { marginLeft: request.marginLeft } : {},
    ...request.marginRight !== undefined ? { marginRight: request.marginRight } : {},
    ...request.scale !== undefined ? { scale: request.scale } : {},
    ...request.pageRanges !== undefined ? { pageRanges: request.pageRanges } : {},
    ...request.preferCSSPageSize !== undefined ? { preferCSSPageSize: request.preferCSSPageSize } : {},
  }

  // Electron's in-process CDP answers every other method but not this one ("Error:
  // 'Page.printToPDF' wasn't found", measured on Electron 44 against a real host), and the
  // desktop shell drives that same debugger — so on the Electron carriers the document has to
  // come from the child's own print pipeline. Only a "method missing" failure falls back: a
  // real CDP error (a closed target, a refused document) is reported as itself.
  let base64 = ''
  try {
    const reply = await withTimeout(deps.send(viewId, 'Page.printToPDF', params), PDF_TIMEOUT_MS, 'CDP Page.printToPDF')
    base64 = typeof reply.data === 'string' ? reply.data : ''
  } catch (error) {
    if (deps.nativePdf === undefined || !METHOD_NOT_IMPLEMENTED.test(String(error))) {
      throw new BrowserError(`browser: printing the page to PDF failed: ${String(error)}`, 'BROWSER_PDF_FAILED', { cause: error })
    }
    try {
      base64 = (await deps.nativePdf(viewId, request)).base64
    } catch (nativeError) {
      throw new BrowserError(`browser: printing the page to PDF failed: ${String(nativeError)}`, 'BROWSER_PDF_FAILED', { cause: nativeError })
    }
  }

  if (base64 === '') {
    throw new BrowserError('browser: printing the page to PDF returned no data', 'BROWSER_PDF_EMPTY')
  }
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.byteLength > MAX_PDF_BYTES) {
    throw new BrowserError(
      `browser: the PDF is ${String(bytes.byteLength)} bytes, over the ${String(MAX_PDF_BYTES)}-byte cap`,
      'BROWSER_PDF_TOO_LARGE',
    )
  }

  try {
    deps.writeFile(target, bytes)
  } catch (error) {
    throw new BrowserError(`browser: writing the PDF to "${target}" failed: ${String(error)}`, 'BROWSER_PDF_SAVE_FAILED', { cause: error })
  }
  return { path: target, bytes: bytes.byteLength }
}
