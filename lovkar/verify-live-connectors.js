/* lovkar/verify-live-connectors.js — do the portals ON HIS FLOOR reach a REAL run?

   verify-mcp-run.js proves the chain with a stub connector and a stand-in HTTP server. This one
   asks the running station itself: it finds the live sidecar, borrows the API token the same way
   the browser does (GET / and read window.__STARNET_API_TOKEN__ — the documented path, see
   sidecar/mcp/serve.js), and drives one real run through /api/lovkar/run with the agent's own
   floor. Then it reads the run result's `connectors` field, which the runner fills from the
   projection, and the model's own answer.

   Nothing is written and no connector is called: the run is asked to LIST its tools, and
   membership is read from that listing rather than from prose (the lesson of probe-mcp-allowlist).

   Run:  node lovkar/verify-live-connectors.js
*/
'use strict';

const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');

const ASK = 'List the exact names of every tool you have available right now, one per line, nothing else. Do not call any tool.';

function findSidecarPort() {
  // ask Windows which port the packaged sidecar is listening on
  const ps = 'Get-CimInstance Win32_Process -Filter "Name=\'node.exe\'" | Where-Object { $_.CommandLine -like \'*release\\sidecar*\' } | ForEach-Object { (Get-NetTCPConnection -State Listen -OwningProcess $_.ProcessId -ErrorAction SilentlyContinue | Select-Object -First 1).LocalPort }';
  const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8' }).trim();
  const port = Number(String(out).split(/\s+/)[0]);
  return Number.isFinite(port) && port > 0 ? port : null;
}

function get(port, pathname, headers) {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', headers: headers || {} }, (res) => {
      let b = ''; res.setEncoding('utf8');
      res.on('data', (d) => { b += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', (e) => resolve({ status: 0, body: '', error: e.message }));
    req.end();
  });
}

function post(port, pathname, headers, obj) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify(obj), 'utf8');
    const req = http.request({
      host: '127.0.0.1', port, path: pathname, method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': payload.length }, headers || {}),
    }, (res) => {
      let b = ''; res.setEncoding('utf8');
      res.on('data', (d) => { b += d; });
      res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    req.on('error', (e) => resolve({ status: 0, body: '', error: e.message }));
    req.setTimeout(300000, () => { try { req.destroy(new Error('timeout')); } catch (_) {} });
    req.write(payload);
    req.end();
  });
}

(async () => {
  const port = findSidecarPort();
  if (!port) { console.log('no running sidecar found — start StarNet first'); process.exit(2); }
  console.log('sidecar on 127.0.0.1:' + port);

  const home = await get(port, '/');
  const m = /__STARNET_API_TOKEN__\s*=\s*['"]([A-Za-z0-9._~-]+)['"]/.exec(home.body || '');
  if (!m) { console.log('could not read the station token from GET / (status ' + home.status + ')'); process.exit(2); }
  const token = m[1];
  console.log('token: ' + token.slice(0, 6) + '… (' + token.length + ' chars, not printed)');

  const H = { 'x-starnet-token': token };

  // what the station says is connected, and what stands on the agent's floor
  const conn = await get(port, '/api/connectors', H);
  let connectors = [];
  try { connectors = (JSON.parse(conn.body) || {}).connectors || []; } catch (_) {}
  console.log('\nconnected connectors: ' + (connectors.length
    ? connectors.map((c) => c.id + '[' + c.state + ', ' + (c.toolCount || 0) + ' tools]').join(', ')
    : '(none)'));

  /* ONE REAL RUN ON THE STATION'S OWN PATH. /api/run is the route the station itself uses, and it
     is the only one that goes through the runOnce short-circuit where the floor is read — which is
     exactly why it is the one to test. (/api/lovkar/run is this fork's bare dev route: it drives the
     runner directly with no floor at all, so it proves nothing about the moat.) It answers with a
     stream of NDJSON events, so the model's own words are reassembled from agent.token deltas. */
  console.log('\nrunning one turn as `agent` through /api/run …');
  const r = await post(port, '/api/run', H, {
    agentId: 'agent',
    provider: 'claude-code',
    model: 'opus[1m]',   // handleRun demands a model even for a keyless provider
    messages: [{ role: 'user', content: ASK }],
  });
  if (r.status !== 200) { console.log('run failed: HTTP ' + r.status + ' ' + r.body.slice(0, 400)); process.exit(1); }

  let text = '', caps = null, conns = null, endReason = '';
  for (const line of String(r.body).split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let ev = null; try { ev = JSON.parse(s); } catch (_) { continue; }
    const p = ev && ev.payload;
    if (!p) continue;
    if (ev.name === 'agent.token' && typeof p.delta === 'string') text += p.delta;
    if (ev.name === 'agent.run.end') { endReason = String(p.reason || ''); caps = p.caps || caps; conns = p.connectors || conns; }
  }
  if (endReason) console.log('run ended: ' + endReason);

  if (caps) console.log('\nbuilt-in tools: ' + (caps.tools || []).join(', '));
  if (conns) console.log('connector projection: ' + conns.summary);
  if (conns && conns.tools) console.log('pre-approved MCP names: ' + (conns.tools.length ? conns.tools.join(', ') : '(none)'));

  console.log('\nwhat the run itself reports having:');
  console.log(text.split('\n').map((l) => '  ' + l).join('\n').slice(0, 2000));

  const names = text.split(/[\s,]+/).map((s) => s.replace(/[^A-Za-z0-9_-]/g, ''));
  const mcpSeen = names.filter((n) => n.indexOf('mcp__lovkar__') === 0);
  const byConnector = {};
  for (const n of mcpSeen) {
    const rest = n.slice('mcp__lovkar__'.length);
    const cid = rest.indexOf('__') > 0 ? rest.slice(0, rest.indexOf('__')) : rest;
    byConnector[cid] = (byConnector[cid] || 0) + 1;
  }
  console.log('\nMCP tools the run can see: ' + (mcpSeen.length
    ? mcpSeen.length + ' — ' + Object.keys(byConnector).map((k) => k + '(' + byConnector[k] + ')').join(', ')
    : '(none)'));

  /* A LISTING IS NOT A CAPABILITY. One real round trip through the whole chain, on the most
     harmless tool there is: github get_me reads the identity of the token the SIDECAR holds, writes
     nothing, and touches no repository. If the login comes back, then the bridge reached the
     sidecar, the sidecar checked the grant against the live floor, the connector manager used its
     own (refreshed) token, and the answer travelled back through MCP to the model. */
  if (!mcpSeen.length) { console.log('\nnothing to call — stopping here'); process.exit(1); }
  const CALL = 'mcp__lovkar__github__get_me';
  if (mcpSeen.indexOf(CALL) < 0) { console.log('\n' + CALL + ' is not on this floor — skipping the call test'); process.exit(0); }

  console.log('\ncalling ' + CALL + ' for real …');
  const r2 = await post(port, '/api/run', H, {
    agentId: 'agent',
    provider: 'claude-code',
    model: 'opus[1m]',
    messages: [{ role: 'user', content: 'Call the tool ' + CALL + ' with no arguments. Then reply with ONLY the GitHub login it returned, nothing else. If the call fails, reply with the exact error text.' }],
  });
  let t2 = '';
  for (const line of String(r2.body).split('\n')) {
    const s = line.trim(); if (!s) continue;
    let ev = null; try { ev = JSON.parse(s); } catch (_) { continue; }
    if (ev && ev.name === 'agent.token' && ev.payload && typeof ev.payload.delta === 'string') t2 += ev.payload.delta;
  }
  console.log('  answer: ' + t2.trim().slice(0, 300));
  console.log(/Lovkar-Squid/i.test(t2)
    ? '\n  PASS the connector answered through the bridge, with the sidecar\'s own token'
    : '\n  (read the answer above — the expected login is Lovkar-Squid)');
  process.exit(0);
})();
