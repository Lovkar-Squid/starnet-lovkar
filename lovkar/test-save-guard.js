/* lovkar/test-save-guard.js — a locked save must never read as a missing one.

   Drives sidecar/routes/lovkar-save-guard.js with a fake save store whose read outcome is
   scripted per attempt, so every branch is exercised without touching a real file or sleeping.

   Run:  node lovkar/test-save-guard.js
*/
'use strict';

const path = require('path');
const { loadGuarded, BACKOFF_MS } = require(path.join(__dirname, '..', 'sidecar', 'routes', 'lovkar-save-guard.js'));

let pass = 0, fail = 0;
function ok(cond, what) { if (cond) { pass++; } else { fail++; console.log('  FAIL  ' + what); } }
function eq(got, want, what) { ok(got === want, what + '  (got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want) + ')'); }

const DOC = { agent: { name: 'NOVA' }, _saveRevision: 206 };

/* A save store whose behaviour is a script of outcomes, one per read attempt. The last entry
   repeats forever, so ['unreadable'] is a permanently locked file. Mirrors the real store:
   load() yields the doc only when the tagged read is 'ok'. */
function fakeStore(script, opts) {
  const o = opts || {};
  let i = 0;
  const seen = [];
  // load() and readTagged() are two reads of the SAME file within one attempt, so they must see
  // the same outcome: load() advances the script, readTagged() reports the attempt just taken.
  const at = (n) => script[Math.min(Math.max(n, 0), script.length - 1)];
  const store = {
    reads: seen,
    load(agentId) {
      const outcome = at(i);
      seen.push(outcome);
      i++;
      if (o.throwOnLoad) throw new Error('boom');
      return outcome === 'ok' ? (o.docMissing ? undefined : DOC) : undefined;
    },
  };
  if (!o.noInternals) {
    store._internals = {
      saveFile: (id) => 'C:/fake/' + id + '.save.json',
      readTagged: () => {
        const outcome = at(i - 1);
        if (outcome === 'ok') return { status: 'ok', wrapper: o.docMissing ? {} : { doc: DOC } };
        if (outcome === 'absent') return { status: 'absent' };
        if (outcome === 'corrupt') return { status: 'corrupt', err: new Error('bad json') };
        return { status: 'unreadable', err: Object.assign(new Error('locked'), { code: o.code || 'EBUSY' }) };
      },
    };
  }
  return store;
}

function run(script, opts, guardOpts) {
  const slept = [];
  const store = fakeStore(script, opts);
  const r = loadGuarded(store, 'agent', Object.assign({ sleep: (ms) => { slept.push(ms); return ms; } }, guardOpts || {}));
  return { r, slept, store };
}

console.log('save guard — a locked save is not a missing save\n');

// 1. the healthy boot: one read, no waiting
{
  const { r, slept } = run(['ok']);
  eq(r.status, 'ok', 'healthy: status');
  ok(r.doc === DOC, 'healthy: returns the doc itself');
  eq(r.attempts, 1, 'healthy: one attempt');
  eq(r.waitedMs, 0, 'healthy: waits not at all');
  eq(slept.length, 0, 'healthy: never sleeps');
}

// 2. a genuine first run must not be slowed down by the retry budget
{
  const { r, slept } = run(['absent']);
  eq(r.status, 'absent', 'first run: status');
  eq(r.doc, null, 'first run: no doc');
  eq(r.attempts, 1, 'first run: one attempt');
  eq(slept.length, 0, 'first run: never sleeps — onboarding stays instant');
}

// 3. THE BUG: locked, then it clears. This is the case that used to show onboarding.
{
  const { r, slept } = run(['unreadable', 'unreadable', 'ok']);
  eq(r.status, 'ok', 'transient lock: recovers');
  ok(r.doc === DOC, 'transient lock: the station comes back');
  eq(r.attempts, 3, 'transient lock: took three reads');
  eq(slept.length, 2, 'transient lock: slept twice');
  eq(slept[0], BACKOFF_MS[0], 'transient lock: first backoff');
  eq(slept[1], BACKOFF_MS[1], 'transient lock: second backoff');
  eq(r.waitedMs, BACKOFF_MS[0] + BACKOFF_MS[1], 'transient lock: total wait accounted');
}

// 4. locked and staying locked: say BUSY, never "no save"
{
  const { r, slept } = run(['unreadable']);
  eq(r.status, 'busy', 'held lock: reports busy');
  eq(r.doc, null, 'held lock: no doc invented');
  ok(r.status !== 'absent', 'held lock: NEVER absent — this is the whole point');
  eq(r.attempts, BACKOFF_MS.length + 1, 'held lock: one read per backoff plus the first');
  eq(slept.length, BACKOFF_MS.length, 'held lock: exhausts the schedule');
  eq(r.waitedMs, BACKOFF_MS.reduce((a, b) => a + b, 0), 'held lock: total budget spent');
  eq(r.code, 'EBUSY', 'held lock: carries the errno');
}

// 5. the Windows errno the real failure carried
{
  const { r } = run(['unreadable'], { code: 'EACCES' });
  eq(r.code, 'EACCES', 'held lock: reports EACCES too');
}

// 6. corrupt bytes are not a lock — retrying cannot help, so it must not spend the budget
{
  const { r, slept } = run(['corrupt']);
  eq(r.status, 'corrupt', 'corrupt: status');
  eq(r.attempts, 1, 'corrupt: no retry');
  eq(slept.length, 0, 'corrupt: no waiting');
}

// 7. a store too old to expose _internals degrades to the legacy answer instead of throwing
{
  const { r, slept } = run(['unreadable'], { noInternals: true });
  eq(r.status, 'absent', 'legacy store: degrades to absent');
  eq(slept.length, 0, 'legacy store: no waiting');
}

// 8. load() throwing is not a crash
{
  const { r } = run(['absent'], { throwOnLoad: true });
  eq(r.status, 'absent', 'throwing load: still answers');
  eq(r.doc, null, 'throwing load: no doc');
}

// 9. an envelope that reads fine but carries no .doc must terminate, not spin
{
  const { r, slept } = run(['ok'], { docMissing: true });
  eq(r.status, 'absent', 'empty envelope: absent');
  eq(r.attempts, 1, 'empty envelope: does not loop');
  eq(slept.length, 0, 'empty envelope: no waiting');
}

// 10. the schedule is injectable, and it is what bounds the work
{
  const { r, slept } = run(['unreadable'], {}, { backoffMs: [5, 5] });
  eq(slept.length, 2, 'custom schedule: honoured');
  eq(r.attempts, 3, 'custom schedule: bounds the attempts');
  eq(r.waitedMs, 10, 'custom schedule: bounds the wait');
  eq(r.status, 'busy', 'custom schedule: still reports busy');
}

// 11. a zero-length schedule means "one read, then answer" — no retry, still not 'absent'
{
  const { r, slept } = run(['unreadable'], {}, { backoffMs: [] });
  eq(slept.length, 0, 'empty schedule: no sleeps');
  eq(r.attempts, 1, 'empty schedule: single read');
  eq(r.status, 'busy', 'empty schedule: busy, not absent');
}

// 12. the real sleep is only reachable on the failure path — a healthy read never calls it
{
  const store = fakeStore(['ok']);
  const r = loadGuarded(store, 'agent');   // no injected sleep: would block if it tried
  eq(r.status, 'ok', 'default sleep: healthy path never blocks');
  eq(r.waitedMs, 0, 'default sleep: nothing waited');
}

// 13. the log hook fires exactly when something worth reporting happened
{
  const lines = [];
  const store = fakeStore(['unreadable', 'ok']);
  const r = loadGuarded(store, 'agent', { sleep: () => 1, log: (m) => lines.push(m) });
  eq(r.status, 'ok', 'log hook: recovered');
  eq(lines.length, 1, 'log hook: one line on a recovered read');
  ok(/attempt 2/.test(lines[0]), 'log hook: names the attempt');

  const quiet = [];
  loadGuarded(fakeStore(['ok']), 'agent', { sleep: () => 1, log: (m) => quiet.push(m) });
  eq(quiet.length, 0, 'log hook: silent on a clean boot');

  const loud = [];
  loadGuarded(fakeStore(['unreadable']), 'agent', { sleep: () => 1, log: (m) => loud.push(m) });
  eq(loud.length, 1, 'log hook: one line when it gives up');
  ok(/BUSY/.test(loud[0]), 'log hook: says BUSY, loudly');
}

console.log('');
console.log(fail === 0 ? ('OK — ' + pass + ' passed, 0 failed') : (pass + ' passed, ' + fail + ' FAILED'));
process.exit(fail === 0 ? 0 : 1);
