/* lovkar/test-mcp-caps.js — the floor projected onto connectors, and the refusals around it.

   Covers the three pure pieces of the connector path:
     claudecode-mcp.js         floor defs -> --mcp-config servers + --allowedTools names
     lovkar-mcp-grants.js      the per-run grant: minted, looked up, revoked, expired
     lovkar-mcp.js             the loopback routes, including every way they say no

   Run:  node lovkar/test-mcp-caps.js
*/
'use strict';

const path = require('path');
const S = path.join(__dirname, '..', 'sidecar');
const { resolveClaudeMcp, publishedNameOf, fullName } = require(path.join(S, 'runners', 'claudecode-mcp.js'));
const { makeGrants } = require(path.join(S, 'routes', 'lovkar-mcp-grants.js'));
const { makeLovkarMcp } = require(path.join(S, 'routes', 'lovkar-mcp.js'));

let pass = 0, fail = 0;
function ok(cond, what) { if (cond) pass++; else { fail++; console.log('  FAIL  ' + what); } }
function eq(got, want, what) { ok(got === want, what + '  (got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want) + ')'); }

const BRIDGE = 'C:/x/sidecar/mcp/lovkar-bridge.js';
const URLB = 'http://127.0.0.1:60723';

function def(name, extra) {
  return Object.assign({
    name: name,
    description: 'does a thing',
    schema: { type: 'object', properties: { q: { type: 'string' } } },
    run: async () => ({ content: [{ type: 'text', text: 'ran ' + name }] }),
  }, extra || {});
}

console.log('the floor, projected onto connectors\n');

/* ---------------------------------------------------------------- the projection */
{
  const empty = resolveClaudeMcp({ defs: [], bridgePath: BRIDGE, url: URLB, grantId: 'g1' });
  eq(empty.servers, null, 'no connector on the floor declares no server');
  eq(empty.allowedTools.length, 0, 'and pre-approves nothing');
  ok(/connectors: none/.test(empty.summary), 'and says so in the log line');
}
{
  const r = resolveClaudeMcp({
    defs: [def('mcp__github__search_code'), def('mcp__github__list_issues'), def('mcp__MyServer__run_command')],
    bridgePath: BRIDGE, url: URLB, grantId: 'g1', nodePath: 'C:/node.exe',
  });
  eq(r.published.length, 3, 'three defs publish three tools');
  eq(r.published[0].name, 'github__search_code', 'the station\'s own mcp__ prefix is stripped once');
  eq(r.allowedTools[0], 'mcp__lovkar__github__search_code', 'and the allow-list name is the full CLI name');
  eq(r.grant['github__search_code'], 'mcp__github__search_code', 'the grant maps published name -> station def name');
  ok(!!r.servers && !!r.servers.lovkar, 'one server for every portal, not one each');
  eq(r.servers.lovkar.command, 'C:/node.exe', 'spawned with the node we were given');
  eq(r.servers.lovkar.args.length, 1, 'argv carries the bridge path and nothing else');
  ok(r.servers.lovkar.args.indexOf('g1') < 0, 'the grant id is NOT in argv');
  eq(r.servers.lovkar.env.LOVKAR_MCP_GRANT, 'g1', 'it rides in the environment instead');
  eq(r.servers.lovkar.env.LOVKAR_MCP_URL, URLB, 'with the loopback url');
  ok(/github\(2\)/.test(r.summary) && /MyServer\(1\)/.test(r.summary), 'the summary counts per connector');
  eq(r.published[0].inputSchema.type, 'object', 'the station schema is republished as inputSchema');
}
{
  const r = resolveClaudeMcp({ defs: [def('mcp__github__a'), def('mcp__github__a')], bridgePath: BRIDGE, url: URLB, grantId: 'g' });
  eq(r.published.length, 1, 'a duplicate wire name publishes once');
}
{
  const r = resolveClaudeMcp({ defs: [def('mcp__bad name__x'), def('mcp__ok__y')], bridgePath: BRIDGE, url: URLB, grantId: 'g' });
  eq(r.published.length, 1, 'a name that cannot survive the allow-list is dropped');
  eq(r.dropped.length, 1, 'and reported as dropped, not silently lost');
}
{
  const noGrant = resolveClaudeMcp({ defs: [def('mcp__github__a')], bridgePath: BRIDGE, url: URLB });
  eq(noGrant.servers, null, 'without a grant id there is no server — fail closed');
  const noUrl = resolveClaudeMcp({ defs: [def('mcp__github__a')], bridgePath: BRIDGE, grantId: 'g' });
  eq(noUrl.servers, null, 'without a loopback url there is no server either');
}
eq(publishedNameOf('mcp__a__b'), 'a__b', 'publishedNameOf strips exactly one prefix');
eq(publishedNameOf('a__b'), 'a__b', 'and leaves a bare name alone');
eq(fullName('a__b'), 'mcp__lovkar__a__b', 'fullName is the CLI-visible name');

/* ---------------------------------------------------------------- the grant store */
{
  let t = 1000;
  let n = 0;
  const g = makeGrants({ clock: { now: () => t }, random: () => 'id' + (++n), ttlMs: 100 });

  eq(g.mint('run1', { allow: {} }), null, 'a grant that permits nothing is never minted');
  eq(g.mint('run1', null), null, 'and neither is one with no payload');

  const id = g.mint('run1', { allow: { a: 'mcp__a' }, fullPower: true, objects: [1] });
  eq(id, 'id1', 'a real grant gets an id');
  eq(g.size(), 1, 'and is held');
  const got = g.lookup(id);
  eq(got.runId, 'run1', 'lookup carries the run');
  eq(got.fullPower, true, 'and the authority the run was started with');
  eq(g.lookup('nope'), null, 'an unknown id resolves to nothing');

  t = 1099; ok(!!g.lookup(id), 'still live just before the ttl');
  t = 1100; eq(g.lookup(id), null, 'expired on the ttl — a leaked id still dies');
  eq(g.size(), 0, 'and is swept');

  t = 2000;
  const a = g.mint('run2', { allow: { x: 'y' } });
  const b = g.mint('run2', { allow: { x: 'y' } });
  eq(g.size(), 2, 'two grants for one run');
  eq(g.revokeRun('run2'), 2, 'revokeRun takes both');
  eq(g.lookup(a) || g.lookup(b), null, 'and neither resolves after');

  const c = g.mint('run3', { allow: { x: 'y' } });
  eq(g.revoke(c), true, 'revoke removes one');
  eq(g.revoke(c), false, 'and says so when it is already gone');
}

/* ---------------------------------------------------------------- the routes */
function fakeRes() {
  const r = { code: 0, body: null, headers: null };
  r.writeHead = (code, h) => { r.code = code; r.headers = h; };
  r.end = (s) => { try { r.body = JSON.parse(s); } catch (_) { r.body = s; } };
  return r;
}
function fakeReq(grantId, payload) {
  const chunks = payload === undefined ? [] : [Buffer.from(JSON.stringify(payload), 'utf8')];
  return {
    headers: grantId ? { 'x-lovkar-grant': grantId } : {},
    on(ev, cb) {
      if (ev === 'data') for (const c of chunks) cb(c);
      if (ev === 'end') cb();
      return this;
    },
  };
}

async function routeTests() {
  let ran = null;
  const theDef = def('mcp__github__search_code', { run: async (args) => { ran = args; return { content: [{ type: 'text', text: 'hit' }] }; } });
  const connectors = { toolDefsForObjects: (objs) => ((objs || []).length ? [theDef] : []) };

  let n = 0;
  const grants = makeGrants({ random: () => 'g' + (++n) });
  const mcp = makeLovkarMcp({ grants, connectors: () => connectors });

  const shape = resolveClaudeMcp({ defs: [theDef], bridgePath: BRIDGE, url: URLB, grantId: 'x' });
  const mint = (fullPower, objects) => grants.mint('run1', {
    agentId: 'agent', fullPower: fullPower, objects: objects,
    allow: shape.grant, published: shape.published,
  });

  // no grant at all
  let res = fakeRes();
  mcp.handleTools(fakeReq(null), res);
  eq(res.code, 404, 'tools with no grant header: 404');
  res = fakeRes();
  await mcp.handleCall(fakeReq(null, { name: 'x' }), res);
  eq(res.code, 404, 'call with no grant header: 404');

  // a live grant lists exactly what the floor still carries
  const id = mint(true, [{ objectType: 'connector_portal', connectorId: 'github' }]);
  res = fakeRes();
  mcp.handleTools(fakeReq(id), res);
  eq(res.code, 200, 'tools with a live grant: 200');
  eq(res.body.tools.length, 1, 'and publishes the granted tool');
  eq(res.body.tools[0].name, 'github__search_code', 'under its published name');

  // the floor moved: the portal is gone, so the tool stops being published
  const gone = mint(true, []);
  res = fakeRes();
  mcp.handleTools(fakeReq(gone), res);
  eq(res.body.tools.length, 0, 'a portal picked up mid-run disappears from tools/list');
  res = fakeRes();
  await mcp.handleCall(fakeReq(gone, { name: 'github__search_code' }), res);
  eq(res.code, 403, 'and calling it is refused');
  ok(/no longer on this agent/.test(res.body.error), 'with a reason that names the floor');

  // a name the grant never carried
  res = fakeRes();
  await mcp.handleCall(fakeReq(id, { name: 'github__delete_everything' }), res);
  eq(res.code, 403, 'a tool the floor never granted: 403');
  ok(/did not grant/.test(res.body.error), 'and says the floor did not grant it');

  // ASK mode is refused rather than silently escalated
  const ask = mint(false, [{ objectType: 'connector_portal', connectorId: 'github' }]);
  res = fakeRes();
  await mcp.handleCall(fakeReq(ask, { name: 'github__search_code' }), res);
  eq(res.code, 403, 'an ASK-mode run is refused');
  ok(/ASK mode/.test(res.body.error) && /FULL POWER/.test(res.body.error), 'and told exactly why, and what would change it');
  eq(ran, null, 'and the connector was never called');

  // full power runs it
  res = fakeRes();
  await mcp.handleCall(fakeReq(id, { name: 'github__search_code', arguments: { q: 'hello' } }), res);
  eq(res.code, 200, 'a full-power run reaches the connector');
  eq(res.body.result.content[0].text, 'hit', 'and gets the connector\'s own result back');
  eq(ran && ran.q, 'hello', 'with the arguments it sent');

  // a connector that throws is an answer, not a crash
  const boom = def('mcp__github__search_code', { run: async () => { throw new Error('connector down'); } });
  const mcp2 = makeLovkarMcp({ grants, connectors: () => ({ toolDefsForObjects: () => [boom] }) });
  res = fakeRes();
  await mcp2.handleCall(fakeReq(id, { name: 'github__search_code' }), res);
  eq(res.code, 200, 'a throwing connector still answers');
  eq(res.body.error, 'connector down', 'with its own message');

  // bad json
  res = fakeRes();
  const badReq = { headers: { 'x-lovkar-grant': id }, on(ev, cb) { if (ev === 'data') cb(Buffer.from('{oops', 'utf8')); if (ev === 'end') cb(); return this; } };
  await mcp.handleCall(badReq, res);
  eq(res.code, 400, 'a malformed body is a 400, not a stack trace');
}

routeTests().then(() => {
  console.log('');
  console.log(fail === 0 ? ('OK — ' + pass + ' passed, 0 failed') : (pass + ' passed, ' + fail + ' FAILED'));
  process.exit(fail === 0 ? 0 : 1);
}).catch((e) => { console.log('threw: ' + (e && e.stack || e)); process.exit(1); });
