/* lovkar/test-local-mcp.js — the three conditions a local stdio server has to clear, and the
   refusals when it does not.

   The rule (sidecar/runners/claudecode-local-mcp.js): the Commander listed this agent on the
   server, the run is at FULL POWER, and the floor already granted it a shell. All three, or
   nothing — so a local MCP server never hands out a class of authority the floor has not already
   handed out. Most of this file is the refusals, because that is where the value is.

   Run:  node lovkar/test-local-mcp.js
*/
'use strict';

const path = require('path');
const { resolveLocalMcp, entryProblem } = require(path.join(__dirname, '..', 'sidecar', 'runners', 'claudecode-local-mcp.js'));

let pass = 0, fail = 0;
function ok(c, what) { if (c) pass++; else { fail++; console.log('  FAIL  ' + what); } }
function eq(got, want, what) { ok(got === want, what + '  (got ' + JSON.stringify(got) + ', want ' + JSON.stringify(want) + ')'); }

const SHELL = ['Read', 'Write', 'Bash', 'BashOutput'];
const NOSHELL = ['Read', 'Write', 'WebSearch'];

const REG = {
  version: 1,
  servers: {
    Roblox_Studio: { command: 'cmd.exe', args: ['/c', 'mcp.bat'], agents: ['agent'] },
    Blender: { command: 'uv.exe', args: ['run', 'blender-mcp'], agents: ['agent', 'researcher'] },
  },
};
const full = (over) => Object.assign({ registry: REG, agentId: 'agent', tools: SHELL, fullPower: true }, over || {});
const whyFor = (r, name) => (r.refused.find((x) => x.name === name) || {}).why || '';

console.log('local stdio servers — three conditions, or nothing\n');

/* ---- the happy path ---- */
{
  const r = resolveLocalMcp(full());
  eq(r.granted.length, 2, 'all three conditions met: both servers granted');
  ok(!!r.servers && !!r.servers.Roblox_Studio, 'the server is declared');
  eq(r.servers.Roblox_Studio.command, 'cmd.exe', 'with its command');
  eq(r.servers.Roblox_Studio.args.join(' '), '/c mcp.bat', 'and its args');
  eq(r.allowedTools.indexOf('mcp__Roblox_Studio') >= 0, true, 'pre-approved by SERVER name — the measured form');
  eq(r.allowedTools.indexOf('mcp__Roblox_Studio__*') >= 0, false, 'and not by the wildcard form, which does not work');
  eq(r.refused.length, 0, 'nothing refused');
  ok(/local: Blender, Roblox_Studio|local: Roblox_Studio, Blender/.test(r.summary), 'the summary names them');
}

/* ---- condition 1: the Commander's grant ---- */
{
  const r = resolveLocalMcp(full({ agentId: 'analyst' }));
  eq(r.servers, null, 'an agent the Commander did not list gets nothing');
  eq(r.granted.length, 0, 'and nothing granted');
  ok(/has not listed analyst/.test(whyFor(r, 'Roblox_Studio')), 'and the reason names the agent');
  const r2 = resolveLocalMcp(full({ agentId: 'researcher' }));
  eq(r2.granted.join(','), 'Blender', 'a per-server list really is per server');
}

/* ---- condition 2: FULL POWER ---- */
{
  const r = resolveLocalMcp(full({ fullPower: false }));
  eq(r.servers, null, 'an ASK-mode run gets no local server');
  ok(/not at FULL POWER/.test(whyFor(r, 'Roblox_Studio')), 'and is told why');
}

/* ---- condition 3: the floor already granted a shell ---- */
{
  const r = resolveLocalMcp(full({ tools: NOSHELL }));
  eq(r.servers, null, 'no workbench on the floor: no local server');
  ok(/no workbench/.test(whyFor(r, 'Roblox_Studio')), 'and the reason says so');
  ok(/local execution/.test(whyFor(r, 'Roblox_Studio')), 'and says what the objection actually is');
}
{
  // the rule is AND, so any single failure is enough — checked one at a time
  eq(resolveLocalMcp(full({ fullPower: false, tools: NOSHELL })).granted.length, 0, 'two failures still nothing');
  eq(resolveLocalMcp(full({ agentId: 'nobody', fullPower: false })).granted.length, 0, 'and three');
}

/* ---- parked ---- */
{
  const reg = { servers: { X: { command: 'a.exe', args: [], agents: ['agent'], enabled: false } } };
  const r = resolveLocalMcp(full({ registry: reg }));
  eq(r.granted.length, 0, 'enabled:false parks a server');
  ok(/disabled in the registry/.test(whyFor(r, 'X')), 'with that reason');
}

/* ---- a registry is still input ---- */
{
  eq(resolveLocalMcp(full({ registry: null })).servers, null, 'no registry at all: nothing, no crash');
  eq(resolveLocalMcp(full({ registry: {} })).servers, null, 'a registry with no servers key: nothing');
  eq(resolveLocalMcp({}).servers, null, 'no options at all: nothing');
}
{
  const bad = {
    servers: {
      'bad name': { command: 'a.exe', args: [], agents: ['agent'] },
      NoCommand: { command: '', args: [], agents: ['agent'] },
      Newline: { command: 'a.exe\nrm -rf', args: [], agents: ['agent'] },
      BadArgs: { command: 'a.exe', args: 'not-an-array', agents: ['agent'] },
      NullArg: { command: 'a.exe', args: ['ok', 'has\u0000nul'], agents: ['agent'] },
      NoAgents: { command: 'a.exe', args: [] },
      BadEnvKey: { command: 'a.exe', args: [], agents: ['agent'], env: { '2bad': 'x' } },
      Good: { command: 'a.exe', args: [], agents: ['agent'] },
    },
  };
  const r = resolveLocalMcp(full({ registry: bad }));
  eq(r.granted.join(','), 'Good', 'only the valid entry survives');
  eq(r.refused.length, 7, 'and every bad one is refused, not dropped in silence');
  ok(/not usable in an allow-list/.test(whyFor(r, 'bad name')), 'a name that breaks the allow-list is named');
  ok(/command must be/.test(whyFor(r, 'NoCommand')), 'an empty command is named');
  ok(/command must be/.test(whyFor(r, 'Newline')), 'a newline in the command is named');
  ok(/args must be an array/.test(whyFor(r, 'BadArgs')), 'args that are not an array are named');
  ok(/every arg must be/.test(whyFor(r, 'NullArg')), 'a NUL in an arg is named');
  ok(/agents must be an array/.test(whyFor(r, 'NoAgents')), 'a missing agents list is named — no agent named means nobody');
  ok(/env key is invalid/.test(whyFor(r, 'BadEnvKey')), 'a bad env key is named');
  ok(/refused:/.test(r.summary), 'and the summary carries the refusals into the audit line');
}

/* ---- cwd and env ride through when they are valid ---- */
{
  const reg = { servers: { X: { command: 'a.exe', args: ['-x'], cwd: 'C:/tmp', env: { FOO: 'bar' }, agents: ['agent'] } } };
  const r = resolveLocalMcp(full({ registry: reg }));
  eq(r.servers.X.cwd, 'C:/tmp', 'cwd is carried');
  eq(r.servers.X.env.FOO, 'bar', 'env is carried');
}

/* ---- entryProblem on its own ---- */
{
  eq(entryProblem({ command: 'a', agents: [] }), '', 'a minimal valid entry has no problem');
  ok(entryProblem(null) !== '', 'null is a problem');
  ok(entryProblem({ command: 'a', agents: [], args: new Array(65).fill('x') }) !== '', '65 args is a problem');
}

console.log('');
console.log(fail === 0 ? ('OK — ' + pass + ' passed, 0 failed') : (pass + ' passed, ' + fail + ' FAILED'));
process.exit(fail === 0 ? 0 : 1);
