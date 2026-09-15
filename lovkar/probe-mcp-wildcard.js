/* lovkar/probe-mcp-wildcard.js — can a whole MCP server be pre-approved without naming its tools?

   probe-mcp-stdio.js settled how MCP is gated: --mcp-config decides which servers exist, and
   --allowedTools mcp__<server>__<tool> decides which of their tools may be called under dontAsk.

   That is fine for the connector bridge, whose tool list the sidecar already knows. It is a
   problem for a LOCAL stdio server declared straight into the config (Roblox Studio, Blender,
   windows-mcp): the CLI spawns it, so this side never sees its tools/list and cannot enumerate
   names for the allow-list.

   If a server-wide allow form works, the wiring is trivial. If it does not, the sidecar has to
   spawn the server once at run start, ask it for tools/list, and cache the names — which is more
   code, but also a better audit. Either way it is one measurement, not a guess.

   Forms tried, all with --permission-mode dontAsk:
     A  --allowedTools mcp__probe          (server name alone)
     B  --allowedTools mcp__probe__*       (explicit wildcard)
     C  --allowedTools mcp__probe*         (prefix glob)
     D  the exact name                     (the control — known to work)

   Spends a few subscription turns. Run:  node lovkar/probe-mcp-wildcard.js
*/
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const VAULT = path.join(REPO, 'vault');
const CLAUDE = process.env.LOVKAR_CLAUDE_EXE || 'claude';
const ALPHA = 'mcp__probe__alpha_ping';

const SERVER_SRC = `'use strict';
const TOOLS = [{ name: 'alpha_ping', description: 'Answer with ALPHA-OK.', inputSchema: { type: 'object', properties: {} } }];
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch (_) { continue; }
    const r = handle(m);
    if (r) process.stdout.write(JSON.stringify(r) + '\\n');
  }
});
const ok = (id, result) => ({ jsonrpc: '2.0', id, result });
function handle(m) {
  if (m.method === 'initialize') return ok(m.id, { protocolVersion: (m.params && m.params.protocolVersion) || '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1.0.0' } });
  if (m.method === 'notifications/initialized' || m.method === 'notifications/cancelled') return null;
  if (m.method === 'tools/list') return ok(m.id, { tools: TOOLS });
  if (m.method === 'tools/call') return ok(m.id, { content: [{ type: 'text', text: 'ALPHA-OK' }] });
  if (m.id != null) return { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'no' } };
  return null;
}
`;

function run(allowed, cfg) {
  return new Promise((resolve) => {
    const args = ['-p', '--output-format', 'json', '--restricted', '--add-dir', VAULT, '--tools', 'Read'];
    if (allowed) args.push('--allowedTools', allowed);
    args.push('--mcp-config', cfg, '--strict-mcp-config', '--permission-mode', 'dontAsk', '--permission-prompts', 'none');
    const child = spawn(CLAUDE, args, { cwd: VAULT, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', () => {});
    child.on('error', (e) => resolve('spawn error: ' + e.message));
    child.on('close', () => { try { resolve(String(JSON.parse(out).result || '')); } catch (_) { resolve(out); } });
    child.stdin.write('Call the tool ' + ALPHA + ' with no arguments and reply with ONLY the exact text it returned. If you cannot call it, reply exactly NOTOOL.');
    child.stdin.end();
  });
}

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovkar-wild-'));
  const js = path.join(dir, 's.js');
  const cfg = path.join(dir, 'mcp.json');
  fs.writeFileSync(js, SERVER_SRC, { mode: 0o600 });
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { probe: { command: process.execPath, args: [js] } } }), { mode: 0o600 });

  console.log('can a whole server be pre-approved at once?\n');
  const forms = [
    ['mcp__probe', 'the server name alone'],
    ['mcp__probe__*', 'an explicit wildcard'],
    ['mcp__probe*', 'a prefix glob'],
    [ALPHA, 'the exact name (control)'],
  ];
  const results = [];
  try {
    for (const [form, label] of forms) {
      const text = await run(form, cfg);
      const worked = /ALPHA-OK/.test(text);
      results.push([form, worked]);
      console.log('  ' + (worked ? 'WORKS  ' : 'no     ') + form.padEnd(26) + label);
      if (!worked) console.log('           ' + text.trim().replace(/\n/g, ' ').slice(0, 150));
    }
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }

  const wildcards = results.slice(0, 3).filter(([, w]) => w).map(([f]) => f);
  console.log('');
  console.log(wildcards.length
    ? 'A whole server CAN be pre-approved: ' + wildcards.join(' , ')
    : 'No server-wide form works — the tool names have to be enumerated before the run.');
  process.exit(0);
})();
