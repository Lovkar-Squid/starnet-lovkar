/* lovkar/verify-long-dispatch.js — a delegated worker runs for MINUTES, and that has to be fine.

   The first real dispatch died with "the station could not complete team_dispatch — sidecar
   timeout". Not the station: the bridge. It capped every call at 120s, which is exactly the
   mistake orchestration.js warns about in its own comment — team.dispatch awaits whole worker
   agent-loops and cannot live under a fast-tool cap. The host allows eight minutes
   (ORCH_DISPATCH_TIMEOUT_MS); the bridge was cutting at two, so the wrong timeout won the race and
   the lead was told the station broke while the worker was still working.

   The earlier crew test passed only because its subtask was answerable in one word. This one gives
   the worker something that genuinely takes a while, and checks the thing that actually matters:

     1. the dispatch RETURNS the worker's answer instead of a timeout
     2. it took longer than the old 120s cap — otherwise this proves nothing
     3. the worker's own run is in the history, so it really was a separate run

   Spends a few subscription turns and one Gemini call. Run:  node lovkar/verify-long-dispatch.js
*/
'use strict';

const http = require('http');
const { execFileSync } = require('child_process');

const OLD_CAP_MS = 120000;

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
    r.setTimeout(1800000, () => { try { r.destroy(); } catch (_) {} });
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
  if (!port) { console.log('no running sidecar'); process.exit(2); }
  const home = await call(port, 'GET', '/', {});
  const token = (/__STARNET_API_TOKEN__\s*=\s*['"]([A-Za-z0-9._~-]+)['"]/.exec(home.body) || [])[1];
  if (!token) { console.log('could not read the station token'); process.exit(2); }
  const H = { 'x-starnet-token': token };

  console.log('a delegated worker runs for minutes\n');
  console.log('dispatching a real research subtask to RESEARCHER — this is meant to take a while …');

  const ask = 'Use the tool mcp__lovkar__team_dispatch to give RESEARCHER (agent id "researcher") exactly this subtask: '
    + '"Write a short sourced brief, under 300 words, on how a Flutter app should store a shared list for two users '
    + 'against a self-hosted FastAPI backend: name the two or three realistic options, and for each give one sentence '
    + 'on the trade-off. Cite a source per option." '
    + 'Then reply with ONLY what RESEARCHER returned. If the dispatch fails, reply with the exact error text.';

  const t0 = Date.now();
  const r = await call(port, 'POST', '/api/run', H, {
    agentId: 'agent', provider: 'claude-code', model: 'opus[1m]',
    messages: [{ role: 'user', content: ask }],
  });
  const elapsed = Date.now() - t0;
  const d = drain(r.body);

  console.log('\nlead run ' + d.runId + ' — ' + d.reason + '   elapsed ' + Math.round(elapsed / 1000) + 's');
  console.log('lead said (first 300): ' + d.text.trim().slice(0, 300).replace(/\n/g, ' '));
  console.log('');

  ok(!/sidecar timeout|did not answer within/i.test(d.text), '1: no timeout came back from the bridge', d.text.slice(0, 300));
  ok(d.text.trim().length > 200, '1: the worker returned real content', 'length ' + d.text.trim().length);
  ok(elapsed > OLD_CAP_MS, '2: it took longer than the old 120s cap (' + Math.round(elapsed / 1000) + 's) — so this proves something',
    'only ' + Math.round(elapsed / 1000) + 's: the run was too quick to exercise the fix, try a longer subtask');

  const runs = await call(port, 'GET', '/api/runs?agent=*&limit=12', H);
  let rows = [];
  try { rows = JSON.parse(runs.body).runs || []; } catch (_) {}
  const worker = rows.find((x) => x && x.agentId === 'researcher' && Number(x.ts || x.startedAt || 0) > t0 - 60000);
  ok(!!worker, '3: RESEARCHER has its own run record from this dispatch',
    'recent: ' + rows.slice(0, 5).map((x) => x.agentId + '/' + x.reason).join(', '));

  console.log('');
  console.log(fail === 0 ? ('OK — ' + pass + ' passed, 0 failed') : (pass + ' passed, ' + fail + ' FAILED'));
  process.exit(fail === 0 ? 0 : 1);
})();
