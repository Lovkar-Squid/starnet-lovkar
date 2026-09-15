/* lovkar/verify-crew-delegation.js — can the lead hand real work to the real crew?

   Until this, a claude-code lead could only spawn Claude Code subagents and role-play ANALYST and
   RESEARCHER — it said so itself when asked what it could reach, which is how the gap was found.
   team.dispatch and its companions are host builtins created deep inside runOnce, far below the
   claude-code short-circuit, so the run never met them.

   This drives one real run through the station's own /api/run and checks, in order:

     1. the delegation tools are PUBLISHED to the run (team_dispatch and friends)
     2. team.summon is NOT — adding crew is the Commander's act, not the agent's
     3. a dispatch actually runs a DIFFERENT agent and its answer comes back to the lead
     4. the worker's run is in the run history under its own agentId, which is the proof it was a
        real independent run and not the lead pretending

   The worker is CHIEF on Gemini, so this also exercises the piece the host does not need on its
   own path: a keyless claude-code lead must hand the worker its OWN provider credential.

   Spends a few subscription turns plus one Gemini call. Run:  node lovkar/verify-crew-delegation.js
*/
'use strict';

const http = require('http');
const { execFileSync } = require('child_process');

const SENTINEL = 'PINEAPPLE-42';

function sidecarPort() {
  const ps = 'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Where-Object { $_.CommandLine -like \'*release\\sidecar*\' } | ForEach-Object { (Get-NetTCPConnection -State Listen -OwningProcess $_.ProcessId -ErrorAction SilentlyContinue | Select-Object -First 1).LocalPort }';
  const n = Number(execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim().split(/\s+/)[0]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function call(port, method, path, headers, obj) {
  return new Promise((res) => {
    const payload = obj ? Buffer.from(JSON.stringify(obj), 'utf8') : null;
    const r = http.request({ host: '127.0.0.1', port, path, method, headers: Object.assign({}, headers, payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}) }, (x) => {
      let b = ''; x.setEncoding('utf8');
      x.on('data', (d) => { b += d; });
      x.on('end', () => res({ status: x.statusCode, body: b }));
    });
    r.on('error', (e) => res({ status: 0, body: '', error: e.message }));
    r.setTimeout(900000, () => { try { r.destroy(); } catch (_) {} });
    if (payload) r.write(payload);
    r.end();
  });
}

function drain(body) {
  let text = '', reason = '', runId = '';
  for (const line of String(body).split('\n')) {
    const s = line.trim(); if (!s) continue;
    let ev = null; try { ev = JSON.parse(s); } catch (_) { continue; }
    if (!ev || !ev.payload) continue;
    if (ev.name === 'agent.token' && typeof ev.payload.delta === 'string') text += ev.payload.delta;
    if (ev.name === 'agent.run.start' && !runId) runId = String(ev.payload.runId || '');
    if (ev.name === 'agent.run.end') reason = String(ev.payload.reason || '');
  }
  return { text, reason, runId };
}

let pass = 0, fail = 0;
const ok = (c, what, detail) => {
  if (c) { pass++; console.log('  PASS ' + what); }
  else { fail++; console.log('  FAIL ' + what + (detail ? '\n        ' + String(detail).replace(/\n/g, ' ').slice(0, 400) : '')); }
};

(async () => {
  const port = sidecarPort();
  if (!port) { console.log('no running sidecar — start StarNet first'); process.exit(2); }
  const home = await call(port, 'GET', '/', {});
  const token = (/__STARNET_API_TOKEN__\s*=\s*['"]([A-Za-z0-9._~-]+)['"]/.exec(home.body) || [])[1];
  if (!token) { console.log('could not read the station token'); process.exit(2); }
  const H = { 'x-starnet-token': token };

  console.log('can the lead hand real work to the real crew?\n');

  // ---- 1 + 2: what delegation tools the run is given
  const listing = await call(port, 'POST', '/api/run', H, {
    agentId: 'agent', provider: 'claude-code', model: 'opus[1m]',
    messages: [{ role: 'user', content: 'List the exact names of every tool you have available right now, one per line, nothing else. Do not call any tool.' }],
  });
  const seen = drain(listing.body).text;
  const has = (n) => seen.split(/[\s,]+/).map((s) => s.replace(/[^A-Za-z0-9_]/g, '')).indexOf(n) >= 0;

  console.log('1  the delegation tools');
  ok(has('mcp__lovkar__team_dispatch'), '1: team_dispatch is published to the run', seen.slice(0, 300));
  ok(has('mcp__lovkar__team_subagents') && has('mcp__lovkar__team_steer'), '1: and its companions');
  console.log('\n2  what is withheld');
  ok(!has('mcp__lovkar__team_summon'), '2: team_summon is NOT published — adding crew stays the Commander\'s act');

  // ---- 3: a real dispatch to a real, different agent
  console.log('\n3  a real dispatch to CHIEF (gemini)');
  const ask = 'Use the tool mcp__lovkar__team_dispatch to give CHIEF OF STAFF (agent id "chief") exactly this subtask: '
    + '"Reply with exactly the word ' + SENTINEL + ' and nothing else." '
    + 'Then reply with ONLY the exact text CHIEF returned. If the dispatch fails, reply with the exact error.';
  const dispatched = await call(port, 'POST', '/api/run', H, {
    agentId: 'agent', provider: 'claude-code', model: 'opus[1m]',
    messages: [{ role: 'user', content: ask }],
  });
  const d = drain(dispatched.body);
  console.log('  lead run ' + d.runId + ' — ' + d.reason);
  console.log('  lead said: ' + d.text.trim().slice(0, 240));
  ok(new RegExp(SENTINEL).test(d.text), '3: the worker\'s answer reached the lead', d.text);

  // ---- 4: the worker ran as itself, in the history
  console.log('\n4  the worker was a real, separate run');
  const runs = await call(port, 'GET', '/api/runs?agent=*&limit=12', H);
  let rows = [];
  try { rows = JSON.parse(runs.body).runs || []; } catch (_) {}
  const worker = rows.find((r) => r && r.agentId === 'chief' && Number(r.ts || r.startedAt || 0) > Date.now() - 15 * 60 * 1000);
  ok(!!worker, '4: CHIEF has its own run record from the last minutes',
    'recent rows: ' + rows.slice(0, 5).map((r) => r.agentId + '/' + r.provider + '/' + r.reason).join(', '));
  if (worker) ok(worker.parentRunId === d.runId || !!worker.parentRunId, '4: and it is recorded as a child of a lead run', 'parentRunId=' + worker.parentRunId);

  console.log('');
  console.log(fail === 0 ? ('OK — ' + pass + ' passed, 0 failed') : (pass + ' passed, ' + fail + ' FAILED'));
  process.exit(fail === 0 ? 0 : 1);
})();
