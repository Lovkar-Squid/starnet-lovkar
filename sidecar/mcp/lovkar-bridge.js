#!/usr/bin/env node
/* sidecar/mcp/lovkar-bridge.js — the per-run connector bridge (stdio MCP server).

   Spawned by the Claude Code CLI for one run, declared in that run's --mcp-config. It publishes
   the connector tools the FLOOR granted that agent, and forwards each call to the running sidecar
   over loopback. It holds no credential of any kind: the sidecar's connector manager owns every
   OAuth token, refreshes one on a 401 and rotates it on its own schedule, which is the reason
   this shape exists at all (see lovkar/probe-mcp-config.js for the route that was rejected —
   writing the Commander's live access token into a per-run file).

   It is also NOT a security boundary. This process is a child of the CLI the agent drives, so
   anything it enforces, the agent could in principle bypass. The real refusal is in the sidecar,
   which re-checks every call against the run's grant. What this does is keep the published tool
   list honest, so a model is never shown a tool it cannot use.

   Environment (never argv — a Windows command line is readable by any process on the machine):
     LOVKAR_MCP_URL     http://127.0.0.1:<port>   the running sidecar
     LOVKAR_MCP_GRANT   the run's grant id, minted at run start and revoked when it ends

   Protocol: newline-delimited JSON-RPC 2.0 on stdin/stdout. stdout is the wire and carries
   nothing else; every diagnostic goes to stderr.
*/
'use strict';

const http = require('http');
const { URL } = require('url');

const URL_BASE = String(process.env.LOVKAR_MCP_URL || '').trim();
const GRANT = String(process.env.LOVKAR_MCP_GRANT || '').trim();
const JSONRPC = '2.0';
const SERVER_INFO = { name: 'lovkar', version: '1.0.0' };
const PROTOCOL_FALLBACK = '2024-11-05';

/* The CLI that spawns this process swallows its stderr, so a bridge that fails fails silently —
   which is exactly how the first wiring attempt looked from the outside (tools present, model
   sees none, nothing anywhere says why). Everything also goes to a capped file next to the
   station's own run audit. LOVKAR_MCP_LOG names it; without it, stderr alone. */
const LOGFILE = String(process.env.LOVKAR_MCP_LOG || '').trim();
function log() {
  const line = '[lovkar-bridge] ' + Array.prototype.join.call(arguments, ' ');
  try { process.stderr.write(line + '\n'); } catch (_) {}
  if (!LOGFILE) return;
  try {
    try { if (require('fs').statSync(LOGFILE).size > 262144) require('fs').unlinkSync(LOGFILE); } catch (_) {}
    require('fs').appendFileSync(LOGFILE, new Date().toISOString() + ' ' + line + '\n');
  } catch (_) {}
}

// ---------------------------------------------------------------- loopback to the sidecar

function callSidecar(method, pathname, body) {
  return new Promise((resolve) => {
    if (!URL_BASE || !GRANT) return resolve({ status: 0, json: null, error: 'bridge not configured' });
    let u;
    try { u = new URL(pathname, URL_BASE); } catch (e) { return resolve({ status: 0, json: null, error: 'bad url' }); }
    // Loopback only, always. A bridge that could be pointed at another host would be a way to
    // post the station's own grant somewhere else.
    if (u.hostname !== '127.0.0.1' && u.hostname !== 'localhost') {
      return resolve({ status: 0, json: null, error: 'refusing a non-loopback sidecar url' });
    }
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      host: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method: method,
      headers: Object.assign(
        { 'x-lovkar-grant': GRANT, 'Accept': 'application/json' },
        payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}
      ),
    }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { buf += d; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(buf); } catch (_) { json = null; }
        resolve({ status: res.statusCode || 0, json: json, raw: buf });
      });
    });
    req.on('error', (e) => resolve({ status: 0, json: null, error: (e && e.message) || String(e) }));
    req.setTimeout(120000, () => { try { req.destroy(new Error('sidecar timeout')); } catch (_) {} });
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------- MCP

function ok(id, result) { return { jsonrpc: JSONRPC, id: id, result: result }; }
function fail(id, code, message) { return { jsonrpc: JSONRPC, id: id, error: { code: code, message: message } }; }
function textResult(text, isError) {
  const r = { content: [{ type: 'text', text: String(text) }] };
  if (isError) r.isError = true;
  return r;
}

async function listTools() {
  const r = await callSidecar('GET', '/api/lovkar/mcp/tools', null);
  if (r.status !== 200 || !r.json || !Array.isArray(r.json.tools)) {
    log('tools/list FAILED: status=' + r.status + ' ' + (r.error || '') + ' body=' + String(r.raw || '').slice(0, 200));
    return [];   // an empty list is the truthful answer when the station cannot be asked
  }
  log('tools/list ok: ' + r.json.tools.length + ' tools');
  return r.json.tools;
}

async function callTool(name, args) {
  const r = await callSidecar('POST', '/api/lovkar/mcp/call', { name: String(name || ''), arguments: args || {} });
  if (r.status === 403) return textResult('refused: the floor did not grant "' + name + '" to this run', true);
  if (r.status === 404) return textResult('refused: this run has no live grant (it may have ended)', true);
  if (r.status !== 200 || !r.json) {
    return textResult('the station could not complete "' + name + '"' + (r.error ? ' — ' + r.error : ' — HTTP ' + r.status), true);
  }
  if (r.json.error) return textResult(String(r.json.error), true);
  // The connector's own MCP result is passed through untouched when it is already well formed.
  if (r.json.result && Array.isArray(r.json.result.content)) return r.json.result;
  return textResult(typeof r.json.result === 'string' ? r.json.result : JSON.stringify(r.json.result == null ? {} : r.json.result));
}

async function handle(msg) {
  const m = msg && msg.method;
  if (m === 'initialize') {
    const want = (msg.params && msg.params.protocolVersion) || PROTOCOL_FALLBACK;
    return ok(msg.id, { protocolVersion: String(want), capabilities: { tools: {} }, serverInfo: SERVER_INFO });
  }
  if (m === 'notifications/initialized' || m === 'notifications/cancelled') return null;
  if (m === 'ping') return ok(msg.id, {});
  if (m === 'tools/list') return ok(msg.id, { tools: await listTools() });
  if (m === 'tools/call') {
    const name = msg.params && msg.params.name;
    const args = (msg.params && msg.params.arguments) || {};
    if (!name) return fail(msg.id, -32602, 'tools/call needs a name');
    try { return ok(msg.id, await callTool(name, args)); }
    catch (e) { return ok(msg.id, textResult('bridge error: ' + ((e && e.message) || e), true)); }
  }
  if (msg && msg.id != null) return fail(msg.id, -32601, 'method not supported: ' + String(m));
  return null;   // a notification we do not handle gets no reply, per JSON-RPC
}

// ---------------------------------------------------------------- the wire

let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg = null;
    try { msg = JSON.parse(line); } catch (_) { continue; }   // a malformed frame is dropped, never fatal
    Promise.resolve(handle(msg)).then((reply) => {
      if (reply) { try { process.stdout.write(JSON.stringify(reply) + '\n'); } catch (_) {} }
    }).catch((e) => log('handler threw: ' + ((e && e.message) || e)));
  }
});
process.stdin.on('end', () => process.exit(0));
process.on('uncaughtException', (e) => { log('uncaught: ' + ((e && e.message) || e)); });

log('started url=' + (URL_BASE || '(none)') + ' grant=' + (GRANT ? GRANT.slice(0, 6) + '…' : '(none)'));
if (!URL_BASE || !GRANT) log('started WITHOUT a grant — it will publish no tools');
