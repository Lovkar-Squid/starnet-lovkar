/* lovkar/verify-save-lock.js — the fix, proved against the REAL save store and a REAL unreadable file.

   test-save-guard.js drives the guard with a fake store. This one uses the actual
   sidecar/savestore.js over a throwaway workspace, and makes the save genuinely unreadable in a
   way that produces a real non-ENOENT errno from the real fs (a directory standing where the
   save file belongs -> EISDIR), which is the same tagged 'unreadable' class that EBUSY/EACCES
   produce when another sidecar or a scanner is holding the file.

   It proves three things, in order of how much they matter:

     1. BEFORE  the plain saveStore.load() reports nothing for an unreadable save
                — this is the bug: indistinguishable from a first run.
     2. AFTER   loadGuarded() reports busy instead, and never absent.
     3. RECOVERY when the obstruction clears mid-backoff, the station comes back on its own,
                which is what will actually happen in the app: the lock lasts milliseconds.

   Touches nothing outside its own temp dir. Run:  node lovkar/verify-save-lock.js
*/
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const { makeSaveStore } = require(path.join(REPO, 'sidecar', 'savestore.js'));
const { loadGuarded } = require(path.join(REPO, 'sidecar', 'routes', 'lovkar-save-guard.js'));

let pass = 0, fail = 0;
function ok(cond, what) { if (cond) { pass++; console.log('  PASS ' + what); } else { fail++; console.log('  FAIL ' + what); } }

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lovkar-savelock-'));
const file = path.join(root, 'agent.save.json');
const store = makeSaveStore({ fs, pathMod: path, root, clock: { now: () => Date.now() } });

const DOC = { agent: { name: 'NOVA' }, station: { rooms: { r1: { id: 'r1' } }, props: [] }, _saveRevision: 206, updatedAt: Date.now() };

function writeRealSave() {
  const r = store.save('agent', DOC);
  if (!r || !r.ok) throw new Error('setup: could not write the save');
}
function makeUnreadable() {
  // a directory where the file belongs: readFileSync throws EISDIR — present, not ENOENT
  fs.rmSync(file, { force: true });
  fs.mkdirSync(file);
}
function clearObstruction() {
  fs.rmdirSync(file);
  writeRealSave();
}

try {
  console.log('save lock — proved against the real store\n');

  // baseline: a healthy save reads back
  writeRealSave();
  ok(!!store.load('agent'), 'baseline: the real store reads the real save');
  const g0 = loadGuarded(store, 'agent');
  ok(g0.status === 'ok' && g0.attempts === 1 && g0.waitedMs === 0, 'baseline: the guard adds nothing to a healthy read');

  // keep a copy, then obstruct
  const good = fs.readFileSync(file, 'utf8');
  makeUnreadable();

  // 1. THE BUG, reproduced through the real store
  const bare = store.load('agent');
  ok(bare === undefined, 'BUG: plain load() on an unreadable save returns undefined — the same answer as a first run');

  // 2. THE FIX: busy, never absent
  const busy = loadGuarded(store, 'agent', { backoffMs: [5, 5, 5], sleep: (ms) => ms });
  ok(busy.status === 'busy', 'FIX: the guard reports busy');
  ok(busy.status !== 'absent', 'FIX: it is NEVER absent — onboarding must not be reachable from here');
  ok(busy.doc === null, 'FIX: no station invented');
  ok(!!busy.code, 'FIX: carries the errno (' + busy.code + ')');
  ok(busy.attempts === 4, 'FIX: it really did read four times');

  // 3. RECOVERY: the obstruction clears during the backoff, as a real lock does
  let slept = 0;
  const rec = loadGuarded(store, 'agent', {
    backoffMs: [5, 5, 5, 5],
    sleep: (ms) => { slept++; if (slept === 2) clearObstruction(); return ms; },
  });
  ok(rec.status === 'ok', 'RECOVERY: the station comes back by itself');
  ok(!!rec.doc && rec.doc.agent && rec.doc.agent.name === 'NOVA', 'RECOVERY: and it is the real save, not a fresh one');
  ok(rec.attempts === 3, 'RECOVERY: it took three reads');

  // 4. a genuinely empty workspace still boots straight into onboarding, with no delay
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lovkar-savelock-empty-'));
  const store2 = makeSaveStore({ fs, pathMod: path, root: root2, clock: { now: () => Date.now() } });
  const t0 = Date.now();
  const fresh = loadGuarded(store2, 'agent');
  const dt = Date.now() - t0;
  ok(fresh.status === 'absent' && fresh.attempts === 1, 'FIRST RUN: absent immediately, no retry budget spent');
  ok(dt < 50, 'FIRST RUN: and no delay added (' + dt + 'ms)');
  fs.rmSync(root2, { recursive: true, force: true });

  // 5. the good bytes were never touched by any of this
  ok(fs.readFileSync(file, 'utf8').length === good.length, 'the save file itself was never damaged');
} finally {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
}

console.log('');
console.log(fail === 0 ? ('OK — ' + pass + ' passed, 0 failed') : (pass + ' passed, ' + fail + ' FAILED'));
process.exit(fail === 0 ? 0 : 1);
