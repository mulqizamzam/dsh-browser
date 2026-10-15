// Every new tool's renderer, called with the shapes its provider really returns.
//
// The tool-layer projection is the layer this repo has already lost a field to (see the note at
// the top of tool-layer-passthrough.test.mjs), and the renderer is the part nothing else calls:
// a schema can validate a value and the renderer can still throw on it, which turns a successful
// action into a failed tool call. These call render() directly, including the empty cases.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { apply } from '../lib/tool-browser/index.js'

/** A context just complete enough for apply() to register its tools. */
function tools() {
  const registered = new Map()
  apply({
    tools: { register: tool => { registered.set(tool.name, tool) } },
    systemPrompt: { section: () => undefined },
    effect: () => undefined,
    get: () => ({ open: async () => 'session-1', exists: () => true }),
  })
  return registered
}

/** Render one tool's value and return the text it produced. */
function render(registered, name, args, value) {
  const tool = registered.get(name)
  assert.ok(tool !== undefined, `${name} is registered`)
  const blocks = tool.output.render(args, value)
  assert.ok(Array.isArray(blocks) && blocks.length > 0, `${name} rendered at least one block`)
  return blocks.map(block => block.text ?? '').join('\n')
}

test('browser_pdf renders the path and size', () => {
  const text = render(tools(), 'browser_pdf', { savePath: '/dl/a.pdf' }, { path: '/dl/a.pdf', bytes: 14341 })
  assert.match(text, /\/dl\/a\.pdf/)
  assert.match(text, /14341/)
})

test('browser_trace renders both the running and the written case', () => {
  const registered = tools()
  assert.match(render(registered, 'browser_trace', { action: 'start' }, { tracing: true }), /started/i)
  const written = render(registered, 'browser_trace', { action: 'stop' }, { tracing: false, path: '/dl/t.json', bytes: 117, truncated: true })
  assert.match(written, /\/dl\/t\.json/)
  assert.match(written, /truncated/i)
})

test('browser_video renders a stop with no drops and one with drops', () => {
  const registered = tools()
  assert.match(render(registered, 'browser_video', { action: 'start' }, { recording: true }), /started/i)
  const clean = render(registered, 'browser_video', { action: 'stop' }, { recording: false, path: '/dl/v.mp4', frames: 13, droppedFrames: 0 })
  assert.match(clean, /13 frames/)
  assert.doesNotMatch(clean, /dropped/)
  const dropped = render(registered, 'browser_video', { action: 'stop' }, { recording: false, path: '/dl/v.mp4', frames: 4, droppedFrames: 2 })
  assert.match(dropped, /2 dropped/)
})

test('browser_network renders a list, an empty list, and a body', () => {
  const registered = tools()
  const listed = render(registered, 'browser_network', { action: 'list' }, {
    recording: true,
    total: 4,
    dropped: 0,
    entries: [
      { requestId: '1', url: 'http://x/a.json', method: 'GET', status: 200, encodedBytes: 42 },
      { requestId: '2', url: 'http://x/b.js', method: 'GET', failed: 'net::ERR_FAILED' },
    ],
  })
  assert.match(listed, /2 of 4/)
  assert.match(listed, /GET 200 http:\/\/x\/a\.json \(42 B\)/)
  assert.match(listed, /FAILED/)
  const empty = render(registered, 'browser_network', { action: 'list' }, { recording: false, total: 0, dropped: 3, entries: [] })
  assert.match(empty, /0 of 0/)
  assert.match(empty, /recording is OFF/)
  assert.match(empty, /3 evicted/)
  const body = render(registered, 'browser_network', { action: 'body' }, { recording: false, total: 1, dropped: 0, entries: [], body: '{"ok":true}', base64: false })
  assert.match(body, /\{"ok":true\}/)
})

test('browser_install renders carriers, notes and an install result', () => {
  const registered = tools()
  const status = render(registered, 'browser_install', {}, {
    channel: 'bundled',
    ready: true,
    notes: ['electron found'],
    carriers: [
      { kind: 'electron', path: '/opt/electron', exists: true, version: '44.0.0' },
      { kind: 'chrome', exists: false },
    ],
  })
  assert.match(status, /bundled/)
  assert.match(status, /ready/)
  assert.match(status, /OK\s+electron/)
  assert.match(status, /MISS\s+chrome/)
  assert.match(status, /electron found/)
})
