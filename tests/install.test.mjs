// The install feature is the one place that answers "why is there no browser on this machine,
// and what exactly do I type to fix it", so what it reports is the whole product: a carrier that
// was never probed must not look like a carrier that was probed and missing, and a failed
// installer must not fail quietly.
//
// These drive manageInstall through hand-written InstallDeps doubles — no machine state, no
// network, no ~100 MB download — and assert the report, the notes, and the two refusals.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { manageInstall } from '../lib/browser-electron/features/install.js'

/**
 * An InstallDeps double: nothing found, installElectron succeeds with empty output.
 *
 * The count is kept here rather than in each override so a test can assert both "it was called
 * once" and "it was never called" without wrapping the double again.
 * @param overrides - members to replace.
 * @returns the double, its call count, and the overrides in use.
 */
function makeDeps(overrides = {}) {
  const calls = { installElectron: 0 }
  const base = {
    channel: 'bundled',
    resolveElectron: () => undefined,
    detectSystemBrowser: () => undefined,
    installElectron: async () => ({ ok: true, output: '' }),
  }
  const deps = {
    ...base,
    ...overrides,
    installElectron: async () => {
      calls.installElectron += 1
      const impl = overrides.installElectron ?? base.installElectron
      return await impl()
    },
  }
  return { deps, calls }
}

/** The kinds reported, in report order. */
const kindsOf = result => result.carriers.map(carrier => carrier.kind)

/** The electron carrier of a report. */
const electronOf = result => result.carriers.find(carrier => carrier.kind === 'electron')

/** A working self-hosted runtime. */
const workingElectron = () => ({ path: '/opt/dsh/node_modules/electron/dist/electron', exists: true })

test('nothing installed: all three carriers are reported as absent, not omitted', async () => {
  const { deps } = makeDeps()

  // `{}` is the default action: a caller that asks for nothing gets a status, never a download.
  const result = await manageInstall(deps, {})

  assert.deepEqual(kindsOf(result), ['electron', 'chrome', 'edge'])
  assert.ok(result.carriers.every(carrier => carrier.exists === false))
  assert.equal(result.channel, 'bundled')
  assert.equal(result.ready, false)
  assert.equal('installed' in result, false)
  assert.ok(
    result.notes.some(note => note.includes('npx install-electron')),
    `a missing Electron binary must name the documented fix, got: ${JSON.stringify(result.notes)}`,
  )
  assert.ok(result.notes.some(note => note.includes('ELECTRON_PATH')))
})

test('status is the default action and installElectron is not called for it', async () => {
  const { deps, calls } = makeDeps()
  const explicit = await manageInstall(deps, { action: 'status' })
  const implicit = await manageInstall(deps, {})

  assert.deepEqual(explicit, implicit)
  assert.equal(calls.installElectron, 0)
})

test('a working Electron: the carrier exists, the channel is ready, and nothing is reported missing', async () => {
  const { deps } = makeDeps({ resolveElectron: workingElectron })

  const result = await manageInstall(deps, { action: 'status' })

  assert.equal(electronOf(result).exists, true)
  assert.equal(electronOf(result).path, '/opt/dsh/node_modules/electron/dist/electron')
  assert.equal(result.ready, true)
  assert.deepEqual(result.notes, [])
  assert.ok(result.notes.every(note => !/missing|not found|not installed|install-electron/i.test(note)))
})

test('channel chrome with only Electron available: not ready, and the note names the override', async () => {
  const { deps } = makeDeps({ channel: 'chrome', resolveElectron: workingElectron })

  const result = await manageInstall(deps, {})

  assert.equal(result.ready, false)
  assert.equal(electronOf(result).exists, true)
  assert.ok(
    result.notes.some(note => note.includes('DSH_BROWSER_CHROME_PATH')),
    `a missing Chrome must name the env override, got: ${JSON.stringify(result.notes)}`,
  )
  // The channel in force has to be in the note, or the operator cannot tell which setting failed.
  assert.ok(result.notes.some(note => note.includes('"chrome"')))
})

test('channel auto with Chrome present: ready, and every carrier is still reported', async () => {
  const { deps } = makeDeps({
    channel: 'auto',
    detectSystemBrowser: kind => kind === 'chrome' ? { path: '/usr/bin/google-chrome', version: '131.0.0.0' } : undefined,
  })

  const result = await manageInstall(deps, {})

  assert.equal(result.ready, true)
  assert.deepEqual(kindsOf(result), ['electron', 'chrome', 'edge'])
  const chrome = result.carriers.find(carrier => carrier.kind === 'chrome')
  assert.equal(chrome.exists, true)
  assert.equal(chrome.version, '131.0.0.0')
  assert.equal(electronOf(result).exists, false)
  assert.deepEqual(result.notes, [])
})

test('install/electron: calls the installer once and reports what appeared', async () => {
  let installed = false
  const { deps, calls } = makeDeps({
    resolveElectron: () => installed ? workingElectron() : undefined,
    installElectron: async () => {
      installed = true
      return { ok: true, output: 'Downloading electron v44.0.0\nDone.' }
    },
  })

  const result = await manageInstall(deps, { action: 'install', target: 'electron' })

  assert.equal(calls.installElectron, 1)
  assert.equal(result.installed.kind, 'electron')
  assert.equal(result.ready, true)
  assert.equal(electronOf(result).exists, true)
  assert.ok(
    result.notes.some(note => note.includes('Done.')),
    `the installer's output tail belongs in the notes, got: ${JSON.stringify(result.notes)}`,
  )
})

test('install/electron with no target given still installs the bundled runtime', async () => {
  const { deps, calls } = makeDeps()

  const result = await manageInstall(deps, { action: 'install' })

  assert.equal(calls.installElectron, 1)
  assert.equal(result.installed.kind, 'electron')
})

test('install/electron that fails: BROWSER_INSTALL_FAILED carrying the output tail', async () => {
  const noise = 'x'.repeat(4_000)
  const output = `npm ERR! code ELIFECYCLE\n${noise}\nEND-OF-OUTPUT`
  const { deps } = makeDeps({ installElectron: async () => ({ ok: false, output }) })

  await assert.rejects(
    () => manageInstall(deps, { action: 'install', target: 'electron' }),
    error => {
      assert.equal(error.code, 'BROWSER_INSTALL_FAILED')
      assert.ok(error.message.includes('END-OF-OUTPUT'), 'the failure must carry the end of the output')
      assert.ok(error.message.includes('npm ERR! code ELIFECYCLE') === false, 'only the tail is carried, not the head')
      assert.ok(!error.message.includes('x'.repeat(2_100)), 'the tail is capped at about 2 KB')
      return true
    },
  )
})

test('install/electron that throws: still BROWSER_INSTALL_FAILED, with the reason', async () => {
  const { deps } = makeDeps({
    installElectron: async () => { throw new Error('ENOSPC: no space left on device') },
  })

  await assert.rejects(
    () => manageInstall(deps, { action: 'install' }),
    error => {
      assert.equal(error.code, 'BROWSER_INSTALL_FAILED')
      assert.ok(error.message.includes('ENOSPC'))
      return true
    },
  )
})

test('install/electron that reports success with nothing on disk is not reported as ready', async () => {
  const { deps } = makeDeps({ installElectron: async () => ({ ok: true, output: 'Done.' }) })

  const result = await manageInstall(deps, { action: 'install', target: 'electron' })

  assert.equal(result.installed.kind, 'electron')
  assert.equal(result.ready, false)
  assert.ok(
    result.notes.some(note => note.includes('reported success, but no Electron binary')),
    `ok:true with no binary must be called out, got: ${JSON.stringify(result.notes)}`,
  )
  assert.ok(result.notes.some(note => note.includes('npx install-electron')))
})

test('install/system: refused with BROWSER_INSTALL_UNSUPPORTED, and nothing is installed', async () => {
  const { deps, calls } = makeDeps()

  await assert.rejects(
    () => manageInstall(deps, { action: 'install', target: 'system' }),
    error => {
      assert.equal(error.code, 'BROWSER_INSTALL_UNSUPPORTED')
      assert.match(error.message, /root/)
      assert.match(error.message, /sudo/)
      assert.ok(error.message.includes('DSH_BROWSER_CHROME_PATH'))
      assert.ok(error.message.includes('DSH_BROWSER_EDGE_PATH'))
      return true
    },
  )
  assert.equal(calls.installElectron, 0, 'refusing a system install must not run the Electron installer')
})

test('a probe that throws is reported as absent, not as a failure of the whole status', async () => {
  const { deps } = makeDeps({
    resolveElectron: () => { throw new Error('EACCES: permission denied') },
    detectSystemBrowser: kind => kind === 'edge' ? { path: '/usr/bin/microsoft-edge' } : undefined,
  })

  const result = await manageInstall(deps, { action: 'status' })

  assert.deepEqual(kindsOf(result), ['electron', 'chrome', 'edge'])
  assert.equal(electronOf(result).exists, false)
  assert.equal(result.carriers.find(carrier => carrier.kind === 'edge').exists, true)
})
