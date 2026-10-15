// Fake browser-host child for the event-channel and supervisor tests.
//
// Same line-delimited JSON-RPC protocol as host-main.js (hello with the spawn token, then
// ops), plus the two frames this plugin added: `subscribe` (the parent asks for CDP domains)
// and the child-initiated `cdpEvent` / `hostStopping` notifications. Modes, from
// PROTOCOL_CHILD_MODE:
//   normal   - answers every op, emits cdpEvent frames and a deliberate shutdown on command
//   silent   - authenticates, then never answers (drives the readiness timeout)
//   badtoken - sends a wrong hello, so the parent refuses the connection
import { createConnection } from 'node:net'
import { createInterface } from 'node:readline'

const portArg = process.argv.indexOf('--rpc-port')
const port = Number(process.argv[portArg + 1])
const mode = process.env.PROTOCOL_CHILD_MODE ?? 'normal'
const token = process.env.DSH_BROWSER_RPC_TOKEN ?? ''

const socket = createConnection({ host: '127.0.0.1', port })
socket.setEncoding('utf8')
socket.write(JSON.stringify({ id: 0, op: 'hello', token: mode === 'badtoken' ? 'wrong-token' : token }) + '\n')
if (mode === 'silent') {
  // Authenticated and alive, but never ready: the parent's readiness ping times out.
  socket.on('error', () => {})
  setInterval(() => {}, 1 << 30)
} else {

let subscribedView
const reply = (id, payload) => socket.write(JSON.stringify({ id, ...payload }) + '\n')
const notify = frame => socket.write(JSON.stringify({ id: 0, ...frame }) + '\n')

const rl = createInterface({ input: socket })
rl.on('line', line => {
  const text = line.trim()
  if (text === '') return
  let msg
  try { msg = JSON.parse(text) } catch { return }
  if (typeof msg.id !== 'number' || typeof msg.op !== 'string') return
  if (msg.op === 'subscribe') {
    subscribedView = msg.viewId
    reply(msg.id, { ok: true, result: { viewId: msg.viewId, domains: msg.domains, dropped: 0 } })
    return
  }
  if (msg.op === 'command') {
    if (msg.method === '__die') process.exit(1)
    if (msg.method === '__emit') {
      // Prove the channel works in the direction the plugin needs: child -> parent, unsolicited.
      notify({ op: 'cdpEvent', windowId: 'w1', viewId: subscribedView, method: 'Network.responseReceived', params: { requestId: 'r1', response: { status: 200 } } })
      reply(msg.id, { ok: true, result: { emitted: true } })
      return
    }
    if (msg.method === '__stop') {
      // A deliberate end of session: the frame first, then the connection, then exit 0.
      notify({ op: 'hostStopping', reason: 'last window closed' })
      reply(msg.id, { ok: true })
      setTimeout(() => { try { socket.end() } catch { /* gone */ } ; setTimeout(() => process.exit(0), 25) }, 25)
      return
    }
    reply(msg.id, { ok: true, result: { value: 'fake' } })
    return
  }
  reply(msg.id, { ok: true })
})

// Leave with the parent so no zombie node process survives the suite.
socket.on('close', () => process.exit(0))
socket.on('error', () => {})
}
