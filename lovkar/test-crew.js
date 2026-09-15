/* lovkar/test-crew.js — which of the station's delegation tools a run may see.

   The live proof is lovkar/verify-crew-delegation.js (a real dispatch to a real worker). This is
   the pure half: the projection from the floor to the published tool set, and the one deliberate
   withholding.

   Run:  node lovkar/test-crew.js
*/
'use strict';

const path = require('path');
const { resolveClaudeCrew, EXPOSED, WITHHELD } = require(path.join(__dirname, '..', 'sidecar', 'runners', 'claudecode-crew.js'));

let pass = 0, fail = 0;
function ok(c, what) { if (c) pass++; else { fail++; console.log('  FAIL  ' + what); } }
function eq(got, want, what) { ok(got === want, what + '  (got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want) + ')'); }

function tool(name) {
  return { name: name, description: 'the host tool ' + name, schema: { type: 'object', properties: { p: { type: 'string' } } }, run: async () => ({ content: 'ran ' + name }) };
}
const ORCH = {
  dispatchTool: tool('team.dispatch'),
  spawnTool: tool('team.spawn'),
  summonTool: tool('team.summon'),
  subagentsTool: tool('team.subagents'),
  steerTool: tool('team.steer'),
  interruptTool: tool('team.interrupt'),
  resumeTool: tool('team.resume'),
};

console.log('the station\'s delegation, projected onto a run\n');

/* ---- the floor decides ---- */
{
  const none = resolveClaudeCrew({ orchestration: ORCH, granted: false });
  eq(none.published.length, 0, 'no orchestrator on the floor: no delegation');
  eq(none.allowedTools.length, 0, 'and nothing pre-approved');
  eq(none.defs.length, 0, 'and nothing callable');
  ok(/no orchestrator on the floor/.test(none.summary), 'and the audit line says why');
}
{
  const hostless = resolveClaudeCrew({ orchestration: null, granted: true });
  eq(hostless.published.length, 0, 'granted but no host tools: still nothing');
  ok(/no orchestration host/.test(hostless.summary), 'and it says THAT instead — the two are different failures');
}

/* ---- what a granted run gets ---- */
{
  const r = resolveClaudeCrew({ orchestration: ORCH, granted: true });
  eq(r.published.length, 6, 'six of the seven host tools are published');
  const names = r.published.map((p) => p.name);
  for (const n of ['team_dispatch', 'team_spawn', 'team_subagents', 'team_steer', 'team_interrupt', 'team_resume']) {
    ok(names.indexOf(n) >= 0, 'published: ' + n);
  }

  // THE ONE THAT MATTERS
  ok(names.indexOf('team_summon') < 0, 'team_summon is WITHHELD — adding crew is the Commander\'s act, not the agent\'s');
  ok(Object.keys(r.grant).indexOf('team_summon') < 0, 'and it is not in the grant either, so the route cannot call it');
  ok(!r.defs.some((d) => d.tool && d.tool.name === 'team.summon'), 'and no def carries it');
  eq(WITHHELD.join(','), 'summonTool', 'the withheld list is explicit, not implied by omission');

  eq(r.grant.team_dispatch, 'team.dispatch', 'the grant maps the published name to the host tool name');
  eq(r.allowedTools.indexOf('mcp__lovkar__team_dispatch') >= 0, true, 'pre-approved under the bridge server name');
  eq(r.published[0].inputSchema.type, 'object', 'the host schema is republished as inputSchema');
  ok(/hand a subtask/.test(r.published[0].description), 'the description says what the tool is FOR');
  ok(/the host tool team.dispatch/.test(r.published[0].description), 'and keeps the host\'s own words too');
  ok(/team.summon withheld/.test(r.summary), 'the audit line records the withholding, so it is visible per run');
}

/* ---- a host that hands back junk ---- */
{
  const broken = resolveClaudeCrew({ orchestration: { dispatchTool: { name: 'team.dispatch' } }, granted: true });
  eq(broken.published.length, 0, 'a tool with no run() is not published');
  const partial = resolveClaudeCrew({ orchestration: { dispatchTool: tool('team.dispatch'), steerTool: null }, granted: true });
  eq(partial.published.length, 1, 'a missing tool is skipped, the rest still work');
}

/* ---- the exposed list is data, not scattered conditionals ---- */
{
  eq(EXPOSED.length, 6, 'six tools are listed as exposed');
  ok(EXPOSED.every((e) => Array.isArray(e) && e.length === 3 && e[2]), 'and each carries a reason a human can read');
  ok(!EXPOSED.some((e) => e[0] === 'summonTool'), 'summon is not among them');
}

console.log('');
console.log(fail === 0 ? ('OK — ' + pass + ' passed, 0 failed') : (pass + ' passed, ' + fail + ' FAILED'));
process.exit(fail === 0 ? 0 : 1);
