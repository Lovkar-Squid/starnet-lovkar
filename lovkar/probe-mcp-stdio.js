/* lovkar/probe-mcp-stdio.js — how a LOCAL stdio MCP server is gated, measured end to end.

   WHAT WAS ALREADY MEASURED, and why neither settled it:
     probe-mcp-config.js     a server named by URL in --mcp-config does NOT reuse the CLI's own
                             OAuth, so that route means writing the Commander's access token to disk.
     probe-mcp-allowlist.js  inheriting every server and pre-approving by name puts the whole
                             connector surface in every prompt.

   Both were about REMOTE, OAuth-authenticated servers. A local stdio server is a different animal:
   the CLI spawns it as a child process, there is no OAuth anywhere, and the process it spawns is
   OURS — so it can proxy to the running sidecar, which already holds and refreshes every token,
   and it can expose exactly the tools the floor grants, because we write its tools/list.

   THE FINDING (2026-09-15, this probe):

     --tools does NOT gate MCP tools.  It gates the built-ins and nothing else. Every tool a
     declared server lists is VISIBLE no matter what --tools says. So the moat cannot be
     projected onto MCP the way it is projected onto Bash and Write.

     Two other gates do work, and together they are enough:
       1. WHICH SERVERS   --mcp-config + --strict-mcp-config. A server that is not declared does
                          not exist (case C). This is the hard gate.
       2. WHICH TOOLS     --allowedTools mcp__<server>__<tool>. Under --permission-mode dontAsk an
                          MCP call is REFUSED unless pre-approved (case D), and allowed when it is
                          (case D2), while a sibling tool of the same server stays refused (case E).

     Visible-but-uncallable is not the moat's usual shape, so the server we ship must also list
     only what the floor granted — the allow-list is the enforcement, our tools/list is the hygiene.

   Spends a few subscription turns. Run:  node lovkar/probe-mcp-stdio.js
*/
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const VAULT = path.join(REPO, 'vault');
const CLAUDE = process.env.LOVKAR_CLAUDE_EXE || 'claude';

const SERVER = 'probe';
const ALPHA = 'mcp__' + SERVER + '__alpha_ping';
const BETA = 'mcp__' + SERVER + '__beta_ping';

const SERVER_SRC = `'use strict';
/* a minimal stdio MCP server: newline-delimited JSON-RPC 2.0, stdout is the wire, stderr is free */
const TOOLS = [
  { name: 'alpha_ping', description: 'Answer with ALPHA-OK.', inputSchema: { type: 'object', properties: {} } },
  { name: 'beta_ping',  description: 'Answer with BETA-OK.',  inputSchema: { type: 'object', properties: {} } },
];
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg; try { msg = JSON.parse(line); } catch (_) { continue; }
    const reply = handle(msg);
    if (reply) process.stdout.write(JSON.stringify(reply) + '\\n');
  }
});
function ok(id, result) { return { jsonrpc: '2.0', id: id, result: result }; }
function handle(msg) {
  const m = msg && msg.method;
  if (m === 'initialize') {
    const want = (msg.params && msg.params.protocolVersion) || '2024-11-05';
    return ok(msg.id, { protocolVersion: want, capabilities: { tools: {} }, serverInfo: { name: 'probe', version: '1.0.0' } });
  }
  if (m === 'notifications/initialized' || m === 'notifications/cancelled') return null;
  if (m === 'tools/list') return ok(msg.id, { tools: TOOLS });
  if (m === 'tools/call') {
    const n = msg.params && msg.params.name;
    const text = n === 'alpha_ping' ? 'ALPHA-OK' : n === 'beta_ping' ? 'BETA-OK' : 'UNKNOWN-TOOL';
    return ok(msg.id, { content: [{ type: 'text', text: text }] });
  }
  if (msg && msg.id != null) return { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no method ' + m } };
  return null;
}
`;

function run({ prompt, tools, allowed, mcp, strict }) {
  return new Promise((resolve) => {
    const args = ['-p', '--output-format', 'json', '--restricted', '--add-dir', VAULT];
    if (tools) args.push('--tools', tools.join(','));
    if (allowed) args.push('--allowedTools', allowed.join(','));
    if (mcp) args.push('--mcp-config', mcp);
    if (strict !== false) args.push('--strict-mcp-config');
    args.push('--permission-mode', 'dontAsk', '--permission-prompts', 'none');

    const child = spawn(CLAUDE, args, { cwd: VAULT, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', () => {});
    child.on('error', (e) => resolve({ text: '', error: e.message }));
    child.on('close', () => {
      let text = '';
      try { const j = JSON.parse(out); text = String(j.result || j.text || ''); } catch (_) { text = out; }
      resolve({ text: text });
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

// membership read from an explicit listing, never from prose — the lesson of probe-mcp-allowlist
const LIST = 'List the exact names of every tool you have available right now, one per line, nothing else. Do not call any tool.';
const has = (text, name) => text.split(/[\s,]+/).map((s) => s.replace(/[^A-Za-z0-9_]/g, '')).includes(name);

let pass = 0, fail = 0;
const check = (cond, what, detail) => {
  if (cond) { pass++; console.log('  PASS ' + what); }
  else { fail++; console.log('  FAIL ' + what + (detail ? '\n        ' + String(detail).replace(/\n/g, '\n        ').slice(0, 500) : '')); }
};

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovkar-mcpstdio-'));
  const serverJs = path.join(dir, 'probe-server.js');
  const cfg = path.join(dir, 'mcp.json');
  fs.writeFileSync(serverJs, SERVER_SRC, { mode: 0o600 });
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { [SERVER]: { command: process.execPath, args: [serverJs] } } }), { mode: 0o600 });

  console.log('stdio MCP through the moat — measured, not assumed\n');

  try {
    // A — a declared stdio server is spawned and its tools appear, with --strict-mcp-config on
    const a = await run({ prompt: LIST, mcp: cfg, tools: ['Read', ALPHA, BETA] });
    console.log('A  declared server, both tools named in --tools');
    check(has(a.text, ALPHA) && has(a.text, BETA), 'A: the stdio server is spawned and both tools appear', a.text);

    // B — the finding: --tools does NOT gate MCP tools (beta survives being left out)
    const b = await run({ prompt: LIST, mcp: cfg, tools: ['Read', ALPHA] });
    console.log('\nB  only alpha named in --tools');
    check(has(b.text, BETA), 'B: beta is STILL there — confirms --tools does not gate MCP tools', b.text);

    // B2 — and naming no MCP tool at all still leaves the whole server visible
    const b2 = await run({ prompt: LIST, mcp: cfg, tools: ['Read'] });
    console.log('\nB2 no MCP name in --tools at all');
    check(has(b2.text, ALPHA) && has(b2.text, BETA), 'B2: the whole server is still visible — same finding, stated twice', b2.text);

    // C — THE HARD GATE: an undeclared server does not exist
    const c = await run({ prompt: LIST, tools: ['Read', ALPHA, BETA] });
    console.log('\nC  control: no --mcp-config');
    check(!has(c.text, ALPHA) && !has(c.text, BETA), 'C: without the config there is no server at all — the server list IS the gate', c.text);

    // D — under dontAsk, a VISIBLE MCP tool is refused unless pre-approved
    const d = await run({ prompt: 'Call the tool ' + ALPHA + ' with no arguments and reply with ONLY the exact text it returns.', mcp: cfg, tools: ['Read', ALPHA] });
    console.log('\nD  call alpha with NO --allowedTools');
    check(!/ALPHA-OK/.test(d.text), 'D: refused — visible is not callable under dontAsk', d.text);

    // D2 — pre-approved by name, it runs
    const d2 = await run({ prompt: 'Call the tool ' + ALPHA + ' with no arguments and reply with ONLY the exact text it returns.', mcp: cfg, tools: ['Read'], allowed: [ALPHA] });
    console.log('\nD2 call alpha WITH --allowedTools');
    check(/ALPHA-OK/.test(d2.text), 'D2: allowed by name, the MCP tool actually runs', d2.text);

    // E — and its sibling on the same server stays refused
    const e = await run({ prompt: 'Call the tool ' + BETA + ' with no arguments and reply with ONLY the exact text it returns. If you cannot, reply exactly NOTOOL.', mcp: cfg, tools: ['Read'], allowed: [ALPHA] });
    console.log('\nE  call beta, only alpha allowed');
    check(!/BETA-OK/.test(e.text), 'E: the sibling is refused — --allowedTools gates per tool, not per server', e.text);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }

  console.log('');
  console.log(fail === 0 ? ('OK — ' + pass + ' passed, 0 failed') : (pass + ' passed, ' + fail + ' FAILED'));
  process.exit(fail === 0 ? 0 : 1);
})();
