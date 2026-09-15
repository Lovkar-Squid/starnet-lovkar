/* lovkar/verify-run-recorded.js — a claude-code run has to EXIST afterwards.

   The short-circuit at the top of runOnce returns before the settle path, where runStore.record()
   lives. So for as long as this fork has existed, every claude-code run ended without entering the
   run history: the Commander could not rate one ("this task is not in the saved run history, so it
   cannot be rated"), the run list stopped at the last Gemini run, and progression had nothing to
   count. Same class as the moat bug — returning early skipped the settle too.

   This drives one real run through the station's own /api/run and then checks the three things
   that were missing:

     1. the run is in the store, as a claude-code run
     2. it is shaped the way the rating route demands: not internal, not clarifying, and a reason
        in {done, max_iters, budget, refusal}
     3. the rating route itself accepts it — asked with the real POST, which is the only proof that
        the button in the corner will work

   The rating written by check 3 is a real one. It is asked for as "ok" and the run it rates is
   this probe's own, so nothing of the Commander's is touched.

   Spends one subscription turn. Run:  node lovkar/verify-run-recorded.js
*/
'use strict';

const http = require('http');
const { execFileSync } = require('child_process');

function sidecarPort() {
  const ps = 'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Where-Object { $_.CommandLine -like \'*release\\sidecar*\' } | ForEach-Object { (Get-NetTCPConnection -State Listen -OwningProcess $_.ProcessId -ErrorAction SilentlyContinue | Select-Object -First 1).LocalPort }';
  const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim().split(/\s+/)[0];
  const n = Number(out);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function call(port, method, path, headers, obj) {
  return new Promise((res) => {
    const payload = obj ? Buffer.from(JSON.stringify(obj), 'utf8') : null;
    const r = http.request({
      host: '127.0.0.1', port, path, method,
      headers: Object.assign({}, headers, payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
    }, (x) => {
      let b = ''; x.setEncoding('utf8');
      x.on('data', (d) => { b += d; });
      x.on('end', () => res({ status: x.statusCode, body: b }));
    });
    r.on('error', (e) => res({ status: 0, body: '', error: e.message }));
    r.setTimeout(300000, () => { try { r.destroy(); } catch (_) {} });
    if (payload) r.write(payload);
    r.end();
  });
}

let pass = 0, fail = 0;
const ok = (c, what, detail) => {
  if (c) { pass++; console.log('  PASS ' + what); }
  else { fail++; console.log('  FAIL ' + what + (detail ? '\n        ' + String(detail).slice(0, 300) : '')); }
};

(async () => {
  const port = sidecarPort();
  if (!port) { console.log('no running sidecar — start StarNet first'); process.exit(2); }

  const home = await call(port, 'GET', '/', {});
  const token = (/__STARNET_API_TOKEN__\s*=\s*['"]([A-Za-z0-9._~-]+)['"]/.exec(home.body) || [])[1];
  if (!token) { console.log('could not read the station token'); process.exit(2); }
  const H = { 'x-starnet-token': token };

  console.log('a claude-code run has to exist afterwards\n');

  const before = await call(port, 'GET', '/api/runs?agent=*&limit=1', H);
  let beforeTop = '';
  try { const rows = (JSON.parse(before.body).runs || []); beforeTop = rows[0] ? rows[0].runId : ''; } catch (_) {}

  console.log('running one turn …');
  const r = await call(port, 'POST', '/api/run', H, {
    agentId: 'agent', provider: 'claude-code', model: 'opus[1m]',
    messages: [{ role: 'user', content: 'Reply with exactly the word RECORDED and nothing else.' }],
  });
  if (r.status !== 200) { console.log('run failed: HTTP ' + r.status + ' ' + r.body.slice(0, 200)); process.exit(1); }

  let runId = '', endReason = '';
  for (const line of String(r.body).split('\n')) {
    const s = line.trim(); if (!s) continue;
    let ev = null; try { ev = JSON.parse(s); } catch (_) { continue; }
    if (!ev || !ev.payload) continue;
    if (ev.name === 'agent.run.start' && ev.payload.runId) runId = String(ev.payload.runId);
    if (ev.name === 'agent.run.end') endReason = String(ev.payload.reason || '');
  }
  console.log('run ' + (runId || '(no id seen)') + ' ended: ' + endReason + '\n');

  // 1. it is in the store
  const after = await call(port, 'GET', '/api/runs?agent=*&limit=10', H);
  let rows = [];
  try { rows = JSON.parse(after.body).runs || []; } catch (_) {}
  const row = rows.find((x) => x && x.runId === runId) || null;
  ok(!!row, '1: the run is in the run history', 'newest row is ' + (rows[0] ? rows[0].runId + ' (' + rows[0].provider + ')' : 'none') + ', before the run it was ' + (beforeTop || 'none'));
  if (!row) { console.log('\n' + pass + ' passed, ' + fail + ' FAILED'); process.exit(1); }
  ok(row.provider === 'claude-code', '1: recorded as a claude-code run', 'provider=' + row.provider);

  // 2. shaped the way the rating route demands
  ok(!row.internal, '2: not marked internal');
  ok(!row.clarifying, '2: not marked clarifying');
  ok(['done', 'max_iters', 'budget', 'refusal'].indexOf(String(row.reason)) >= 0, '2: the reason is a rateable one', 'reason=' + row.reason);
  ok(typeof row.title === 'string' && row.title.length > 0, '2: it carries a title for the list', JSON.stringify(row.title));

  // 3. the rating route itself accepts it
  let epoch = 1;
  try {
    const save = await call(port, 'GET', '/api/save?agent=agent', H);
    const j = JSON.parse(save.body);
    epoch = Math.max(1, Math.floor(Number(j && j.save && j.save.agent && j.save.agent.createdAt) || 1));
  } catch (_) {}
  const rate = await call(port, 'POST', '/api/growth/ratings', H, { runId: runId, verdict: 'ok', epoch: epoch });
  let rated = null; try { rated = JSON.parse(rate.body); } catch (_) {}
  ok(rate.status === 200 && rated && rated.ok !== false, '3: the rating route accepts it', 'HTTP ' + rate.status + ' ' + rate.body.slice(0, 200));

  console.log('');
  console.log(fail === 0 ? ('OK — ' + pass + ' passed, 0 failed') : (pass + ' passed, ' + fail + ' FAILED'));
  process.exit(fail === 0 ? 0 : 1);
})();
