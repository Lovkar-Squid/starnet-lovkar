/* sidecar/runners/claudecode-local-mcp.js — local stdio MCP servers, and the one rule that lets them in.

   WHAT THIS IS NOT. It is not a way around StarNet's stdio isolation. Upstream refuses to spawn a
   stdio MCP server unless its owning agent runs in a Docker Safe Cell, and it means it: the refusal
   is layered four deep (transport.stdio.js hostStdioAllowed defaults to deny, a command-basename
   allowlist, mcpStdioIsolationError's Safe Cell predicate, and a spawnImpl that docker-execs into
   the cell). None of that is touched here. A local server declared through this file never goes
   near the connector manager — the Claude Code CLI spawns it itself, from the per-run --mcp-config,
   which is what that flag is for.

   THE RULE, and the reasoning the Commander agreed to. A local stdio MCP server is arbitrary code
   execution on this machine, driven by the agent. It may therefore be declared into a run ONLY
   when that run already has arbitrary local execution from the floor:

     1. the Commander listed this agent on that server in the registry  (an explicit grant, the
        same act as placing an object: it is the Commander's to give and nobody else's)
     2. the run is at FULL POWER                                        (the authority dial is up)
     3. the floor granted it a shell — a `workbench`, i.e. Bash          (the capability already exists)

   All three, or nothing. Under that rule a local server hands the run no new CLASS of authority:
   whatever it could do through the MCP server, it could already do by typing the same command into
   the Bash it was given. An agent without a workbench, or at ASK, gets nothing — and that is the
   whole point, because for those two the server WOULD be new authority.

   Every refusal is reported with its reason rather than silently dropped: a capability that
   disappears without a word is how the last three bugs in this fork stayed hidden.

     resolveLocalMcp({ registry, agentId, tools, fullPower }) -> {
       servers,       // mcpServers entries to merge into the run's --mcp-config, or null
       allowedTools,  // ['mcp__<name>'] — measured: the server name alone pre-approves all its
                      // tools (lovkar/probe-mcp-wildcard.js), which is what makes this possible
                      // at all, since the CLI spawns the server and we never see its tools/list
       granted,       // [name]
       refused,       // [{ name, why }]
       summary
     }

   Pure: no fs, no spawn. The caller reads the registry file. */

'use strict';

// The server name becomes part of mcp__<name>__<tool>, so it has to survive the allow-list.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$/;
// The shell capability, as claudecode-caps.js names it. A workbench on the floor is what grants it.
const SHELL_TOOL = 'Bash';

function badString(s, max) {
  return typeof s !== 'string' || !s.trim() || s.length > (max || 4096) || /[\0\r\n]/.test(s);
}

/* A registry entry is Commander-authored configuration, but it is still validated like input:
   the file sits in the workspace directory and a bad line should be refused with a reason, not
   turned into a spawn. */
function entryProblem(entry) {
  if (!entry || typeof entry !== 'object') return 'not an object';
  if (badString(entry.command, 1024)) return 'command must be a non-empty single-line string';
  if (entry.args != null && !Array.isArray(entry.args)) return 'args must be an array';
  for (const a of (entry.args || [])) if (badString(a)) return 'every arg must be a non-empty single-line string';
  if ((entry.args || []).length > 64) return 'too many args';
  if (entry.cwd != null && badString(entry.cwd, 1024)) return 'cwd must be a single-line string';
  if (entry.env != null && (typeof entry.env !== 'object' || Array.isArray(entry.env))) return 'env must be an object';
  for (const k of Object.keys(entry.env || {})) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) return 'env key is invalid: ' + k;
    if (badString(String(entry.env[k]), 8192)) return 'env value is invalid: ' + k;
  }
  if (!Array.isArray(entry.agents)) return 'agents must be an array of agent ids (no agent named = nobody gets it)';
  return '';
}

function resolveLocalMcp(opts) {
  const o = opts || {};
  const reg = (o.registry && typeof o.registry === 'object' && o.registry.servers && typeof o.registry.servers === 'object')
    ? o.registry.servers
    : null;
  const agentId = String(o.agentId || '');
  const tools = Array.isArray(o.tools) ? o.tools : [];
  const hasShell = tools.indexOf(SHELL_TOOL) >= 0;
  const fullPower = !!o.fullPower;

  const servers = {};
  const granted = [];
  const refused = [];

  for (const name of Object.keys(reg || {})) {
    const entry = reg[name];

    if (!NAME_RE.test(name)) { refused.push({ name: name, why: 'the server name is not usable in an allow-list' }); continue; }
    const problem = entryProblem(entry);
    if (problem) { refused.push({ name: name, why: problem }); continue; }
    if (entry.enabled === false) { refused.push({ name: name, why: 'disabled in the registry' }); continue; }

    // 1. the Commander's own grant
    if (entry.agents.map(String).indexOf(agentId) < 0) {
      refused.push({ name: name, why: 'the Commander has not listed ' + (agentId || '(no agent)') + ' on this server' });
      continue;
    }
    // 2 + 3. it may not hand out a class of authority the floor has not already handed out
    if (!fullPower) { refused.push({ name: name, why: 'this run is not at FULL POWER' }); continue; }
    if (!hasShell) { refused.push({ name: name, why: 'no workbench on this floor — a local server is local execution, and the floor has not granted any' }); continue; }

    const server = { command: String(entry.command), args: (entry.args || []).map(String) };
    if (entry.cwd) server.cwd = String(entry.cwd);
    if (entry.env && Object.keys(entry.env).length) {
      server.env = {};
      for (const k of Object.keys(entry.env)) server.env[k] = String(entry.env[k]);
    }
    servers[name] = server;
    granted.push(name);
  }

  const bits = [];
  bits.push('local: ' + (granted.length ? granted.join(', ') : 'none'));
  if (refused.length) bits.push('refused: ' + refused.map((r) => r.name + ' (' + r.why + ')').join('; '));

  return {
    servers: granted.length ? servers : null,
    // Measured (lovkar/probe-mcp-wildcard.js): 'mcp__<server>' pre-approves every tool that server
    // publishes, while 'mcp__<server>*' does not. The server name alone is the only form that works
    // without knowing the tool list, and the CLI owns that list here.
    allowedTools: granted.map((n) => 'mcp__' + n),
    granted: granted,
    refused: refused,
    summary: bits.join(' | '),
  };
}

module.exports = { resolveLocalMcp, entryProblem, NAME_RE, SHELL_TOOL };
