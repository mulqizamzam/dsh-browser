// browser_pdf, end to end through the two layers it actually crosses: the feature module that
// talks CDP, and the tool layer that gates and projects it.
//
// The tool half matters because this repo has already shipped one bug of exactly that shape —
// the provider computed a value, the schema declared it, and the tool dropped it. So these
// tests call the registered tools for real and assert what comes back out.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../lib/tool-browser/index.js'
import { printToPdf } from '../lib/browser-electron/features/pdf.js'

/** A context just complete enough for apply() to register its tools. */
function makeContext(services = {}) {
  const tools = new Map()
  const ctx = {
    tools: { register: tool => { tools.set(tool.name, tool) } },
    systemPrompt: { section: () => undefined },
    effect: () => undefined,
    get: name => services[name],
  }
  return { ctx, tools }
}

/** A browser double that records what the tools asked it to do. */
function makeBrowser() {
  const calls = []
  return {
    calls,
    open: async () => 'session-1',
    exists: () => true,
    pdf: async (session, request) => { calls.push({ what: 'pdf', session, request }); return { path: request.savePath, bytes: 1234 } },
    trace: async (session, request) => { calls.push({ what: 'trace', session, request }); return { tracing: request.action === 'start' } },
    video: async (session, request) => { calls.push({ what: 'video', session, request }); return { recording: request.action === 'start' } },
    network: async (session, request) => {
      calls.push({ what: 'network', session, request })
      return { recording: request.action === 'start', entries: [], total: 0, dropped: 0 }
    },
    install: async request => { calls.push({ what: 'install', request }); return { carriers: [], channel: 'bundled', ready: false, notes: [] } },
  }
}

/** The document bytes a fake CDP reply carries. */
const PDF_TEXT = '%PDF-1.4 fake document'

/** A FeatureDeps double whose calls are recorded. */
function makeDeps(overrides = {}) {
  const calls = { send: [], wrote: [], admitted: [] }
  const deps = {
    calls,
    send: async (viewId, method, params) => {
      calls.send.push({ viewId, method, params })
      return { data: Buffer.from(PDF_TEXT).toString('base64') }
    },
    subscribe: async () => {},
    onEvent: () => () => {},
    admit: (savePath) => { calls.admitted.push(savePath); return savePath },
    ffmpegPath: async () => undefined,
    writeFile: (path, data) => { calls.wrote.push({ path, bytes: data.byteLength, text: data.toString('utf8') }) },
  }
  return Object.assign(deps, overrides)
}

test('printToPdf admits the destination before it renders anything', async () => {
  const deps = makeDeps({
    admit: () => { throw new Error('refused: not inside downloadDir') },
  })
  await assert.rejects(printToPdf(deps, 'view-1', { savePath: '/elsewhere/x.pdf' }), /refused/)
  assert.equal(deps.calls.send.length, 0, 'a refused path costs no render')
  assert.equal(deps.calls.wrote.length, 0, 'and writes nothing')
})

test('printToPdf sends Page.printToPDF and writes the decoded bytes', async () => {
  const deps = makeDeps()
  const result = await printToPdf(deps, 'view-7', { savePath: '/tmp/out.pdf', landscape: true })
  assert.equal(deps.calls.send.length, 1, 'one CDP call')
  assert.equal(deps.calls.send[0].method, 'Page.printToPDF')
  assert.equal(deps.calls.send[0].viewId, 'view-7')
  assert.equal(deps.calls.send[0].params.printBackground, true, 'backgrounds are on unless turned off')
  assert.equal(deps.calls.send[0].params.landscape, true, 'the caller’s option travels')
  assert.equal(deps.calls.wrote.length, 1, 'the file is written once')
  assert.equal(deps.calls.wrote[0].text, PDF_TEXT, 'the base64 reply is decoded, not copied')
  assert.deepEqual(result, { path: '/tmp/out.pdf', bytes: Buffer.byteLength(PDF_TEXT) })
})

test('printToPdf names an empty CDP reply instead of writing an empty file', async () => {
  const deps = makeDeps({ send: async () => ({}) })
  await assert.rejects(printToPdf(deps, 'view-1', { savePath: '/tmp/x.pdf' }), error => {
    assert.equal(error.code, 'BROWSER_PDF_EMPTY')
    return true
  })
  assert.equal(deps.calls.wrote.length, 0)
})

test('printToPdf wraps a CDP failure with its cause', async () => {
  const deps = makeDeps({ send: async () => { throw new Error('Target closed') } })
  await assert.rejects(printToPdf(deps, 'view-1', { savePath: '/tmp/x.pdf' }), error => {
    assert.equal(error.code, 'BROWSER_PDF_FAILED')
    assert.match(String(error.message), /Target closed/)
    return true
  })
})

test('browser_pdf hands its arguments to the provider and projects both result fields', async () => {
  const browser = makeBrowser()
  const { ctx, tools } = makeContext({ browser })
  apply(ctx)
  const tool = tools.get('browser_pdf')
  assert.ok(tool !== undefined, 'browser_pdf is registered')
  const value = await tool.execute({ savePath: '/tmp/out.pdf', landscape: true, scale: 0.8 }, { task: 'test' })
  assert.deepEqual(browser.calls[0].request, { savePath: '/tmp/out.pdf', landscape: true, scale: 0.8 })
  assert.deepEqual(value, { path: '/tmp/out.pdf', bytes: 1234 }, 'path and bytes both reach the caller')
})

test('an allow-list that excludes browser_pdf blocks it', async () => {
  const browser = makeBrowser()
  const { ctx, tools } = makeContext({ browser })
  apply(ctx)
  await tools.get('browser_restrict').execute({ allowed: ['browser_snapshot'] }, { task: 'test' })
  await assert.rejects(
    tools.get('browser_pdf').execute({ savePath: '/tmp/out.pdf' }, { task: 'test' }),
    /restricted/,
  )
  assert.equal(browser.calls.length, 0, 'nothing reached the browser')
})

test('a restricted allow-list still lets browser_network READ, but not start', async () => {
  // The allow-list governs what the agent may DO. Reading a log it already recorded is an
  // observation, exactly like browser_history — and the tool descriptions promise as much.
  const browser = makeBrowser()
  const { ctx, tools } = makeContext({ browser })
  apply(ctx)
  await tools.get('browser_restrict').execute({ allowed: ['browser_snapshot'] }, { task: 'test' })
  const listed = await tools.get('browser_network').execute({ action: 'list' }, { task: 'test' })
  assert.equal(listed.recording, false)
  await assert.rejects(
    tools.get('browser_network').execute({ action: 'start' }, { task: 'test' }),
    /restricted/,
  )
})

test('a restricted allow-list still lets browser_install REPORT, but not install', async () => {
  const browser = makeBrowser()
  const { ctx, tools } = makeContext({ browser })
  apply(ctx)
  await tools.get('browser_restrict').execute({ allowed: ['browser_snapshot'] }, { task: 'test' })
  const status = await tools.get('browser_install').execute({}, { task: 'test' })
  assert.equal(status.ready, false)
  await assert.rejects(
    tools.get('browser_install').execute({ action: 'install' }, { task: 'test' }),
    /restricted/,
  )
})

test('a carrier whose CDP lacks Page.printToPDF falls back to its own print pipeline', async () => {
  // Electron's in-process CDP answers every other method but not this one — a live run against
  // Electron 44 reported "Error: 'Page.printToPDF' wasn't found". The desktop shell drives that
  // same debugger, so both Electron carriers depend on this fallback.
  const deps = makeDeps({
    send: async () => { throw new Error("Error: 'Page.printToPDF' wasn't found") },
    nativePdf: async (viewId, request) => {
      deps.calls.native = { viewId, request }
      return { base64: Buffer.from(PDF_TEXT).toString('base64') }
    },
  })
  const result = await printToPdf(deps, 'view-9', { savePath: '/tmp/native.pdf' })
  assert.equal(deps.calls.native.viewId, 'view-9', 'the fallback is asked for the same view')
  assert.equal(deps.calls.native.request.savePath, '/tmp/native.pdf', 'and for the same request')
  assert.equal(deps.calls.wrote[0].text, PDF_TEXT, 'the native document is what lands on disk')
  assert.equal(result.bytes, Buffer.byteLength(PDF_TEXT))
})

test('a real CDP failure is not papered over by the native pipeline', async () => {
  let nativeCalled = false
  const deps = makeDeps({
    send: async () => { throw new Error('Target closed') },
    nativePdf: async () => { nativeCalled = true; return { base64: '' } },
  })
  await assert.rejects(printToPdf(deps, 'view-9', { savePath: '/tmp/x.pdf' }), error => {
    assert.equal(error.code, 'BROWSER_PDF_FAILED')
    assert.match(String(error.message), /Target closed/, 'the real cause is what surfaces')
    return true
  })
  assert.equal(nativeCalled, false, 'only a missing method falls back; a genuine error does not')
})

test('a genuine CDP "not found" error does NOT take the native fallback', async () => {
  // An adversarial probe caught the first version of this trigger: a bare `not found` also
  // matches ordinary CDP failures, and those were being sent down the native path instead of
  // reported. Only phrases that mean "no such method" may fall back.
  for (const message of ['Error: Session with given id not found.', 'Error: Frame with the given id was not found.']) {
    let nativeCalled = false
    const deps = makeDeps({
      send: async () => { throw new Error(message) },
      nativePdf: async () => { nativeCalled = true; return { base64: '' } },
    })
    await assert.rejects(printToPdf(deps, 'view-9', { savePath: '/tmp/x.pdf' }), error => {
      assert.equal(error.code, 'BROWSER_PDF_FAILED', `${message} is a CDP failure`)
      assert.match(String(error.message), /not found/)
      return true
    })
    assert.equal(nativeCalled, false, `no fallback for: ${message}`)
  }
})
