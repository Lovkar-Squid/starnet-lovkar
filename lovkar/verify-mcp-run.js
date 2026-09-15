/* lovkar/verify-mcp-run.js — the whole connector chain, end to end, with a real Claude Code run.

   test-mcp-caps.js tests the pieces. This one runs them together exactly as a station run does:

     the floor  ->  claudecode-mcp.js  ->  a per-run --mcp-config file
                ->  the CLI spawns sidecar/mcp/lovkar-bridge.js
                ->  the bridge asks the sidecar over loopback, carrying the run's grant
                ->  routes/lovkar-mcp.js re-checks the grant AND the live floor
                ->  the connector's own def.run

   The only stand-in is the connector itself: a stub def whose run() records that it was called
   and returns a sentinel, so "the model said it worked" can never be mistaken for "it worked".
   Everything else is the real code — the real bridge process, the real routes, the real grant
   store, the real CLI.

   Three cases:
     1  GRANTED   a portal on the floor: the tool is listed, called, and the sentinel comes back
     2  UNGRANTED a tool of the same server that the grant does not carry: refused by the SIDECAR,
                  not merely absent from the CLI's allow-list
     3  EMPTY     no portal on the floor: no server is declared at all, so there is nothing to call

   Spends a few subscription turns. Run:  node lovkar/verify-mcp-run.js
*/
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const S = path.join(REPO, 'sidecar');
const VAULT = path.join(REPO, 'vault');
const BRIDGE = path.join(S, 'mcp', 'lovkar-bridge.js');
const CLAUDE = process.env.LOVKAR_CLAUDE_EXE || 'claude';

const { resolveClaudeMcp } = require(path.join(S, 'runners', 'claudecode-mcp.js'));
const { makeGrants } = require(path.join(S, 'routes', 'lovkar-mcp-grants.js'));
const { makeLovkarMcp } = require(path.join(S, 'routes', 'lovkar-mcp.js'));

const SENTINEL = 'TREASURE-7Q2X';
let pass = 0, fail = 0;
const ok = (cond, what, detail) => {
  if (cond) { pass++; console.log('  PASS ' + what); }
  else { fail++; console.log('  FAIL ' + what + (detail ? '\n        ' + String(detail).replace(/\n/g, '\n        ').slice(0, 400) : '')); }
};

// the stub connector: one tool that records its call, one that must never be reachable
const calls = [];
const defs = [
  {
    name: 'mcp__stubco__fetch_treasure',
    description: 'Return the treasure word.',
    schema: { type: 'object', properties: {} },
    run: async (args) => { calls.push('fetch_treasure'); return { content: [{ type: 'text', text: SENTINEL }] }; },
  },
  {
    name: 'mcp__stubco__burn_it_down',
    description: 'Must never run.',
    schema: { type: 'object', properties: {} },
    run: async () => { calls.push('burn_it_down'); return { content: [{ type: 'text', text: 'BURNED' }] }; },
  },
];

function runClaude(prompt, { mcpConfig, allowed }) {
  return new Promise((resolve) => {
    const args = ['-p', '--output-format', 'json', '--restricted', '--add-dir', VAULT, '--tools', 'Read'];
    if (allowed && allowed.length) args.push('--allowedTools', allowed.join(','));
    if (mcpConfig) args.push('--mcp-config', mcpConfig);
    args.push('--strict-mcp-config', '--permission-mode', 'dontAsk', '--permission-prompts', 'none');
    const child = spawn(CLAUDE, args, { cwd: VAULT, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', () => {});
    child.on('error', (e) => resolve('spawn error: ' + e.message));
    child.on('close', () => {
      try { const j = JSON.parse(out); resolve(String(j.result || j.text || '')); }
      catch (_) { resolve(out); }
    });
    child.stdin.write(prompt);
    child.stdin.end();
  });
}

(async () => {
  console.log('the connector chain, end to end\n');

  const grants = makeGrants({});
  const connectors = { toolDefsForObjects: (objs) => ((objs || []).length ? defs : []) };
  const routes = makeLovkarMcp({ grants, connectors: () => connectors });

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/lovkar/mcp/tools') return routes.handleTools(req, res);
    if (req.method === 'POST' && req.url === '/api/lovkar/mcp/call') return routes.handleCall(req, res);
    res.writeHead(404); res.end('{}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + server.address().port;

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lovkar-mcprun-'));
  try {
    const floor = [{ objectType: 'connector_portal', connectorId: 'stubco' }];

    // ---- 1. GRANTED: only fetch_treasure is in the grant
    const onlyTreasure = defs.slice(0, 1);
    const shape = resolveClaudeMcp({ defs: onlyTreasure, bridgePath: BRIDGE, url, grantId: 'pending' });
    const grantId = grants.mint('verify1', {
      agentId: 'agent', fullPower: true, objects: floor,
      allow: shape.grant, published: shape.published,
    });
    const live = resolveClaudeMcp({ defs: onlyTreasure, bridgePath: BRIDGE, url, grantId: grantId });
    const cfg = path.join(dir, 'mcp.json');
    fs.writeFileSync(cfg, JSON.stringify({ mcpServers: live.servers }), { mode: 0o600 });

    const t1 = await runClaude(
      'Call the tool mcp__lovkar__stubco__fetch_treasure with no arguments, then reply with ONLY the exact text it returned.',
      { mcpConfig: cfg, allowed: live.allowedTools }
    );
    console.log('1  a portal on the floor');
    ok(/TREASURE-7Q2X/.test(t1), '1: the model got the connector\'s real answer back', t1);
    ok(calls.indexOf('fetch_treasure') >= 0, '1: and the connector was genuinely called');

    // ---- 2. UNGRANTED sibling: named in --allowedTools by hand, still refused by the sidecar
    const forced = live.allowedTools.concat(['mcp__lovkar__stubco__burn_it_down']);
    const t2 = await runClaude(
      'Call the tool mcp__lovkar__stubco__burn_it_down with no arguments and reply with ONLY the exact text it returned. If you cannot, reply exactly NOTOOL.',
      { mcpConfig: cfg, allowed: forced }
    );
    console.log('\n2  a sibling tool the FLOOR never granted, force-listed in --allowedTools');
    ok(!/BURNED/.test(t2), '2: the model did not get the forbidden answer', t2);
    ok(calls.indexOf('burn_it_down') < 0, '2: and the connector was NEVER called — the sidecar refused, not the CLI');

    // ---- 3. EMPTY floor: no server is declared at all
    const none = resolveClaudeMcp({ defs: [], bridgePath: BRIDGE, url, grantId: 'whatever' });
    ok(none.servers === null, '3: an empty floor declares no server');
    const t3 = await runClaude(
      'List the exact names of every tool you have available right now, one per line, nothing else. Do not call any tool.',
      { mcpConfig: null, allowed: [] }
    );
    console.log('\n3  nothing on the floor');
    ok(!/stubco/.test(t3), '3: and the run cannot see the connector at all', t3);
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    server.close();
  }

  console.log('');
  console.log(fail === 0 ? ('OK — ' + pass + ' passed, 0 failed') : (pass + ' passed, ' + fail + ' FAILED'));
  process.exit(fail === 0 ? 0 : 1);
})();
