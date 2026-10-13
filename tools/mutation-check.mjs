// Are the guards actually guarding?
//
// A test that passes on a broken implementation proves nothing — and this session's most expensive
// mistakes were exactly that kind. The ownership suite was green while sessions drove each other's
// pages, because it exercised the allocation path and the code took the reuse path. Green suites
// over wrong behaviour are the failure mode to fear here, not red ones.
//
// So: each fix is reverted in turn, and the suite must FAIL. A revert that slips through means that
// fix is not covered, which is worth knowing before a restart is spent on it.
//
//   node tools/mutation-check.mjs
//
// The edited file is restored in a finally block; a crash must not leave the bridge broken, and the
// run exits non-zero if any mutant survives — OR IF A PATTERN NO LONGER MATCHES. Stale used to
// print SKIP and the run still exited 0, which is the one shape that lets a gate confirm itself:
// this file printed "every fix is covered" across two releases while four of seven fixes had moved
// out from under their patterns. A pattern that no longer matches means the fix it guarded was
// rewritten without anyone re-pointing the sabotage at the new shape, so the fix is UNVERIFIED
// here and the run must say so.
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'


// A tool, not a test. `node --test` executes every file it is given, and this one runs on
// purpose — it talks to the live bridge, or edits the source. Node's test runner sets
// NODE_TEST_CONTEXT for the child it spawns for each file, so that is the signal. A test that
// needs to run this tool for real spawns it with the variable cleared.
if (process.env.NODE_TEST_CONTEXT !== undefined) {
  process.exit(0)
}

const BRIDGE = 'desktop-bridge/plugin-browser-bridge.js'
const HOST = 'src/browser-electron/desktop-bridge-host.ts'
// The COMPILED host: behavioural tests import the build, so a sabotage that must change
// behaviour has to land here. Mutations that target HOST are only visible to source-scanning
// suites (session-invariants reads the .ts); pairing one with a behavioural test is a guaranteed
// MISS, which is how this list quietly lost its retry coverage.
const HOST_LIB = 'lib/browser-electron/desktop-bridge-host.js'

/** Each fix, the revert that undoes it, and the test file that must notice. */
const MUTATIONS = [
  {
    name: 'list returns every guest regardless of owner',
    file: BRIDGE,
    patch: (src) => src.replace(
      /const mineOrFree = all\.filter\(g => g\.type !== 'webview' \|\| !claims\.has\(g\.id\) \|\| claims\.get\(g\.id\) === owner\)/,
      'const mineOrFree = all',
    ),
    expect: 'bridge-ownership',
  },
  {
    name: 'showTab does not check ownership',
    file: BRIDGE,
    patch: (src) => src.replace(
      /if \(claims\.has\(viewId\) && claims\.get\(viewId\) !== owner\) \{\s*\n\s*throw new Error\(`showTab: guest \$\{viewId\} belongs to another session`\)\s*\n\s*\}/,
      '',
    ),
    expect: 'bridge-ownership',
  },
  {
    name: 'closeSidebarBrowser does not bound by owner',
    file: BRIDGE,
    patch: (src) => src.replace(/\.filter\(contents => claims\.get\(contents\.id\) === owner\)/, '.filter(contents => true)'),
    expect: '',
  },
  {
    // The ledger left the bridge when the card-clicking path was deleted: the VIEW now carries the
    // conversation it serves, so the sabotage is to read the owner from the process again — the
    // exact mistake guestFor's comment describes.
    name: 'guestFor reads its owner from the process, not the view',
    file: HOST,
    patch: (src) => src.replace('const owner = entry?.owner ?? this.owner', 'const owner = this.owner'),
    expect: 'session-invariants',
  },
  {
    // The recovery that drops a dead guest before re-materializing it. Keeping the drop means the
    // retry asks for the guest that just failed. Targets the BUILD: the behavioural suite imports
    // lib/, so a src-only edit would be invisible to it. tsc splits the guard across two lines,
    // so the statement itself is the anchor.
    name: 'the guest-gone retry reuses the guest that died',
    file: HOST_LIB,
    patch: (src) => src.replace('delete lost.guest;', 'void 0;'),
    expect: 'desktop-bridge-host',
  },
  {
    // One page per conversation is the design; the per-view new-tab guard is gone BY DESIGN, so the
    // invariant is its absence and the sabotage is to put the line back.
    name: 'the per-view new-tab guard comes back',
    file: HOST,
    patch: (src) => src.replace('const entry = this.views.get(viewId)', 'const needsNewTab = this.views.size > 0\n    const entry = this.views.get(viewId)'),
    expect: 'session-invariants',
  },
  {
    // Same shape: the card-clicking path was deleted rather than bounded, so the invariant is its
    // absence and the sabotage is to click the card again.
    name: 'the bridge clicks the launcher card again',
    file: BRIDGE,
    patch: (src) => src.replace('function guestById(id) {', 'function guestById(id) {\n  card.click()'),
    expect: 'session-invariants',
  },
  {
    // A value taken out of a CDP reply must be read from the reply, not from its stringification.
    name: 'the reply-shape mistake returns',
    file: BRIDGE,
    patch: (src) => src.replace('return sendCdp(shellId, method, params)', 'return String(await sendCdp(shellId, method, params))'),
    expect: 'bridge-reply-shape',
  },
  {
    // The headless fix hands the per-child Xvfb to the Electron child as DISPLAY; the client
    // keeps the display object only to tear it down with the child. Dropping the handoff
    // revives the SIGTRAP crash the fix exists to end. Targets the BUILD: the spawn proof
    // imports lib/, so a src-only edit would be invisible to it.
    name: 'the virtual display is never handed to the child',
    file: 'lib/browser-electron/remote-host.js',
    patch: (src) => src.replace('env.DISPLAY = this.virtualDisplay.display;', 'void 0;'),
    expect: 'headless-display',
  },
  {
    // The picker went blind to displays another mount namespace owns: the host browser's Xvfb
    // is invisible through a private /tmp, so the picker handed out the host's own display and
    // Xvfb died binding it — five suite failures with nothing wrong in the code. The fix reads
    // the abstract sockets every namespace shares. Targets the BUILD: the proof imports lib/,
    // and the choice lives in startVirtualDisplay.
    name: 'the picker cannot see a display another namespace owns',
    file: 'lib/browser-electron/headless-display.js',
    patch: (src) => src.replace(
      /const taken = \[\s*\.\.\.takenDisplayNumbers\(socketDir, lockDir\),\s*\.\.\.abstractDisplayNumbers\(procNetUnix\),\s*\];/,
      'const taken = takenDisplayNumbers(socketDir, lockDir);',
    ),
    expect: 'headless-display',
  },
]

/** @returns whether the named test file still passes. */
function passes (name) {
  const glob = name === '' ? 'tests/*.test.mjs' : 'tests/' + name + '.test.mjs'
  try {
    execFileSync(process.execPath, ['--test', glob], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

let uncovered = 0
let stale = 0
console.log('  revert each fix; the suite must notice')
console.log('')
for (const mutation of MUTATIONS) {
  const original = readFileSync(mutation.file, 'utf8')
  const patched = mutation.patch(original)
  if (patched === original) {
    stale += 1
    console.log('  STALE  ' + mutation.name + '  — the pattern no longer matches: the fix moved, so it is NOT re-verified here')
    continue
  }
  writeFileSync(mutation.file, patched)
  try {
    if (passes(mutation.expect)) {
      uncovered += 1
      console.log('  MISS   ' + mutation.name + '  — reverting it changed no test result')
    } else {
      console.log('  ok     ' + mutation.name + '  — caught by ' + (mutation.expect || 'the suite'))
    }
  } finally {
    writeFileSync(mutation.file, original)
  }
}
console.log('')
if (uncovered === 0 && stale === 0) {
  console.log('  every fix is covered: reverting any one of them fails a test')
} else {
  if (uncovered > 0) console.log('  ' + String(uncovered) + ' fix(es) are NOT covered by any test')
  if (stale > 0) console.log('  ' + String(stale) + ' pattern(s) no longer match — update this list before trusting the gate')
}
process.exit(uncovered === 0 && stale === 0 ? 0 : 1)
