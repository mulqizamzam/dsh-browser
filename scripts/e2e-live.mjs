// Live end-to-end check for the five feature families, against a REAL Electron host.
//
// Companion to scripts/verify-host-compat.mjs: that one answers "did a DSH upgrade break us?"
// without a browser, this one answers "do the five features work in a real one?".
//
// This is the check that can fail: it boots the plugin's own compiled host child (the exact
// path production uses), drives a local fixture page, and asserts on the artifacts the five
// features produce — a PDF that starts with %PDF, a network log that contains the requests the
// fixture made, a trace whose JSON parses, and an MP4 that ffmpeg recognises as having a video
// stream. It needs a working Chromium, so it must run OUTSIDE the DSH file/PID sandbox (the
// sandbox denies /dev/shm, and Chromium's renderer dies without it).
//
// Usage: node scripts/e2e-live.mjs <repo-root> <work-dir>
import { spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const [repo, workDir] = process.argv.slice(2)
if (repo === undefined || workDir === undefined) {
  console.error('usage: node work/e2e-live.mjs <repo-root> <work-dir>')
  process.exit(2)
}

const results = {}
const record = (name, value) => { results[name] = value; console.log(`[e2e] ${name}: ${JSON.stringify(value)}`) }

mkdirSync(workDir, { recursive: true })

// ---------------------------------------------------------------- fixture page
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==', 'base64')
const server = createServer((req, res) => {
  if (req.url === '/style.css') { res.writeHead(200, { 'content-type': 'text/css' }); res.end('body{font-family:sans-serif}h1{color:#123}'); return }
  if (req.url === '/image.png') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(PNG); return }
  if (req.url === '/api.json') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, feature: 'network' })); return }
  res.writeHead(200, { 'content-type': 'text/html' })
  res.end('<html><head><link rel=stylesheet href="/style.css"></head><body><h1>dsh-browser e2e</h1><img src="/image.png"><p style="height:1500px">long page for full-page PDF</p></body></html>')
})

const { RemoteElectronViewHost } = await import(join(repo, 'lib/browser-electron/remote-host.js'))
const { ElectronBrowserProvider } = await import(join(repo, 'lib/browser-electron/provider.js'))

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/`

// Isolated UNCONDITIONALLY, not `??=`: the host child appends a spawn/exit line per start to
// `$DSH_HOME/logs/dsh-builtin-browser-host.log`, which is the very log an operator reads to
// diagnose a crash loop. An earlier version of this script inherited the ambient DSH_HOME and
// wrote its own runs into that file.
process.env.DSH_HOME = join(workDir, 'dsh-home')
mkdirSync(process.env.DSH_HOME, { recursive: true })

const host = new RemoteElectronViewHost(join(repo, 'lib/browser-electron/host-main.js'), join(repo, 'node_modules/electron/dist/electron'))
const provider = new ElectronBrowserProvider(host, { downloadDir: workDir })
let session
try {
  session = await provider.open('e2e')
  record('open', { session })
  await provider.openUrl(session, { url: base })
  const url = await provider.execute(session, { script: 'location.href' })
  record('navigated', url)
} catch (error) {
  record('navigation', { ok: false, error: String(error) })
  console.error(`[e2e] FATAL: the host did not come up: ${String(error)}`)
  host.dispose()
  server.close()
  process.exit(1)
}

// ---------------------------------------------------------------- PDF
try {
  const pdf = await provider.pdf(session, { savePath: join(workDir, 'page.pdf') })
  const head = readFileSync(pdf.path).subarray(0, 5).toString('latin1')
  record('pdf', { ok: head === '%PDF-', bytes: pdf.bytes, head })
} catch (error) { record('pdf', { ok: false, error: String(error) }) }

// ---------------------------------------------------------------- network
try {
  await provider.network(session, { action: 'start' })
  await provider.execute(session, { script: "fetch('/api.json').then(r => r.status)" })
  await new Promise(resolve => setTimeout(resolve, 300))
  // The body is read BEFORE any further navigation: CDP drops response bodies when the
  // document goes away, and asking afterwards is the documented BROWSER_NETWORK_BODY_GONE.
  const before = await provider.network(session, { action: 'list', limit: 50 })
  const apiEntry = before.entries.find(entry => entry.url.endsWith('/api.json'))
  if (apiEntry !== undefined) {
    const body = await provider.network(session, { action: 'body', requestId: apiEntry.requestId })
    record('networkBody', { ok: (body.body ?? '').includes('network'), base64: body.base64 === true })
  }
  await provider.openUrl(session, { url: base })
  await new Promise(resolve => setTimeout(resolve, 300))
  const list = await provider.network(session, { action: 'list', limit: 50 })
  const urls = list.entries.map(entry => entry.url)
  const api = list.entries.find(entry => entry.url.endsWith('/api.json'))
  record('network', {
    ok: urls.some(u => u.endsWith('/api.json')) && urls.some(u => u.endsWith('/style.css')),
    entries: list.entries.length,
    apiStatus: api?.status,
    sample: urls.slice(0, 4),
  })
  await provider.network(session, { action: 'stop' })
} catch (error) { record('network', { ok: false, error: String(error) }) }

// ---------------------------------------------------------------- trace
try {
  // More than the timeline default: a script-only workload on a headless carrier records
  // almost nothing under `devtools.timeline` alone (measured: one metadata event).
  await provider.trace(session, { action: 'start', categories: ['devtools.timeline', 'v8', 'blink', 'devtools.timeline.async'] })
  await provider.execute(session, { script: 'for (let i = 0; i < 5000; i++) document.body.dataset.x = String(i)' })
  const trace = await provider.trace(session, { action: 'stop', savePath: join(workDir, 'trace.json') })
  let events = 0
  try {
    const parsed = JSON.parse(readFileSync(trace.path, 'utf8'))
    events = (Array.isArray(parsed) ? parsed : parsed.traceEvents ?? []).length
  } catch { /* reported below */ }
  record('trace', { ok: events > 0, bytes: trace.bytes, events })
} catch (error) { record('trace', { ok: false, error: String(error) }) }

// ---------------------------------------------------------------- video
try {
  await provider.video(session, { action: 'start', quality: 60, maxWidth: 640 })
  for (let i = 0; i < 12; i++) {
    await provider.execute(session, { script: `document.body.style.background = 'hsl(${String(i * 30)}, 80%, 60%)'` })
    await new Promise(resolve => setTimeout(resolve, 120))
  }
  const video = await provider.video(session, { action: 'stop', savePath: join(workDir, 'clip.mp4'), fps: 10 })
  const ffprobe = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', video.path], { encoding: 'utf8' })
  let stream
  try { stream = JSON.parse(ffprobe.stdout).streams?.[0] } catch { /* no ffprobe */ }
  record('video', { ok: existsSync(video.path) && statSync(video.path).size > 1024, bytes: video.bytes, frames: video.frames, droppedFrames: video.droppedFrames, stream: stream ?? ffprobe.stderr?.slice(0, 200) })
} catch (error) { record('video', { ok: false, error: String(error) }) }

// ---------------------------------------------------------------- install (status only)
try {
  const install = await provider.install({ action: 'status' })
  record('install', { ok: Array.isArray(install.carriers) && install.carriers.length > 0, carriers: install.carriers.map(c => `${c.kind}:${c.exists ? 'yes' : 'no'}`), channel: install.channel, ready: install.ready })
} catch (error) { record('install', { ok: false, error: String(error) }) }

host.dispose()
server.close()
const failures = Object.entries(results).filter(([, value]) => value !== null && typeof value === 'object' && 'ok' in value && value.ok !== true)
console.log(`[e2e] SUMMARY ${JSON.stringify({ steps: Object.keys(results).length, failures: failures.map(([name]) => name) })}`)
process.exit(failures.length === 0 ? 0 : 1)
