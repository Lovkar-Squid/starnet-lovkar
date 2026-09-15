/* lovkar/verify-crew-tools.js — every delegation tool that is PUBLISHED has to actually work.

   The first crew verification exercised one tool in its simplest mode — a synchronous dispatch —
   and five more were published on the strength of that. Four of them were dead: they all need the
   durable subagent manager, which the host builds at boot and which the short-circuit was not
   passing. The lead found out the honest way, mid-task, when a background dispatch answered
   "background subagents unavailable (no subagent manager)".

   Publishing a tool is claiming it works. So this asks EACH one, in a single run, and reads the
   answer for the one distinction that matters:

     "unavailable" / "no subagent manager"  -> the dependency is missing; the tool is a lie
     anything else, INCLUDING "not found"   -> the tool reached its real implementation

   A deliberately bogus id is used for steer/interrupt/resume: "not found" from the real manager is
   a PASS, because it proves the call arrived somewhere that can look ids up at all.

   Spends one subscription turn. Run:  node lovkar/verify-crew-tools.js
*/
'use strict';

const http = require('http');
const { execFileSync } = require('child_process');

const TOOLS = [
  ['mcp__lovkar__team_subagents', '{}', 'list the background workers'],
  ['mcp__lovkar__team_steer', '{"id":"nope-000","text":"x"}', 'steer a worker that does not exist'],
  ['mcp__lovkar__team_interrupt', '{"id":"nope-000"}', 'interrupt a worker that does not exist'],
  ['mcp__lovkar__team_resume', '{"id":"nope-000"}', 'resume a worker that does not exist'],
];

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
    r.setTimeout(1200000, () => { try { r.destroy(); } catch (_) {} });
    if (payload) r.write(payload);
    r.end();
  });
}

function drain(body) {
  let text = '', reason = '';
  for (const line of String(body).split('\n')) {
    const s = line.trim(); if (!s) continue;
    let ev = null; try { ev = JSON.parse(s); } catch (_) { continue; }
    const p = ev && ev.payload; if (!p) continue;
    if (ev.name === 'agent.token' && typeof p.delta === 'string') text += p.delta;
    if (ev.name === 'agent.run.end') reason = String(p.reason || '');
  }
  return { text, reason };
}

let pass = 0, fail = 0;
const ok = (c, what, detail) => {
  if (c) { pass++; console.log('  PASS ' + what); }
  else { fail++; console.log('  FAIL ' + what + (detail ? '\n        ' + String(detail).replace(/\n/g, ' ').slice(0, 300) : '')); }
};

(async () => {
  const port = sidecarPort();
  if (!port) { console.log('no running sidecar'); process.exit(2); }
  const home = await call(port, 'GET', '/', {});
  const token = (/__STARNET_API_TOKEN__\s*=\s*['"]([A-Za-z0-9._~-]+)['"]/.exec(home.body) || [])[1];
  if (!token) { console.log('could not read the station token'); process.exit(2); }
  const H = { 'x-starnet-token': token };

  console.log('every published delegation tool, asked one by one\n');

  const steps = TOOLS.map((t, i) => (i + 1) + '. call ' + t[0] + ' with ' + t[1] + '  (' + t[2] + ')').join('\n');
  const ask = 'Call these tools exactly once each, in order, and do not stop if one errors:\n' + steps
    + '\n5. call mcp__lovkar__team_dispatch with {"background":true,"workers":[{"agentId":"chief","prompt":"Reply with exactly the word BG-OK and nothing else."}]}'
    + '\n\nThen reply with exactly five lines, one per call, in this format and nothing else:\n'
    + '<tool name> :: <the first 120 characters of what it returned>';

  const r = await call(port, 'POST', '/api/run', H, {
    agentId: 'agent', provider: 'claude-code', model: 'opus[1m]',
    messages: [{ role: 'user', content: ask }],
  });
  const d = drain(r.body);
  console.log('run ended: ' + d.reason + '\n');
  console.log(d.text.trim().split('\n').map((l) => '  ' + l).join('\n'));
  console.log('');

  const dead = /unavailable|no subagent manager/i;
  const lines = d.text.split('\n');
  const lineFor = (name) => lines.find((l) => l.indexOf(name) >= 0) || '';

  for (const [name] of TOOLS) {
    const l = lineFor(name.replace('mcp__lovkar__', ''));
    ok(l && !dead.test(l), name.replace('mcp__lovkar__', '') + ' reached its real implementation', l || '(no line for it)');
  }
  const disp = lineFor('team_dispatch');
  ok(disp && !dead.test(disp), 'team_dispatch BACKGROUND reached the subagent manager', disp || '(no line for it)');
  ok(/BG-OK|started|queued|id/i.test(disp), 'team_dispatch background actually started something', disp);

  console.log('');
  console.log(fail === 0 ? ('OK — ' + pass + ' passed, 0 failed') : (pass + ' passed, ' + fail + ' FAILED'));
  process.exit(fail === 0 ? 0 : 1);
})();
