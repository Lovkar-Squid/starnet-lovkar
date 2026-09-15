/* sidecar/runners/claudecode-crew.js — the station's own delegation, reaching a Claude Code run.

   THE GAP THIS CLOSES. Asked to hand work to ANALYST or RESEARCHER, the lead could only spawn
   Claude Code subagents and role-play the crew — and it said so plainly, which is how the gap was
   found. The reason is the usual one: `team.dispatch` and its companions are host builtins built
   inside runOnce, hundreds of lines below the claude-code short-circuit, so a claude-code run
   never sees them.

   THIS DOES NOT REIMPLEMENT DELEGATION. sidecar/tools/builtin/orchestration.js already does it,
   carefully: each worker is a distinct agentId taking its own concurrency slot and budget entry,
   the lead's signal is threaded into every child so cancelling the lead cancels the crew, only the
   worker's final message comes back, and lifecycle events are forwarded onto the lead's bus so the
   floor can animate the handoff. The host builds those tools; this file only decides which of them
   a claude-code run may see, and publishes them through the same bridge the connectors use.

   WHAT IS DELIBERATELY WITHHELD: `team.summon`. It adds a crew member, and adding crew is the
   Commander's act, not the agent's — the same line the placement proposals draw ("an agent may
   propose; only the Commander places"). Dispatching work to crew that already exists is the
   agent's job; deciding who exists is not.

   THE GRANT is the `orchestrator` object on the floor — the same object that grants the built-in
   Agent tool. Nothing new to place: if the lead could already delegate to subagents, it can now
   delegate to the real crew.

     resolveClaudeCrew({ orchestration, granted }) -> {
       defs,          // the host tool objects, kept for the route to call
       published,     // [{ name, description, inputSchema }] for the bridge's tools/list
       allowedTools,  // mcp__lovkar__<name>
       grant,         // published name -> host tool name
       summary
     }

   Pure: it receives the host's already-built tools and decides nothing else. */

'use strict';

const SERVER = 'lovkar';

/* Which of the orchestration tools a run may see, and why. The keys are the properties
   makeOrchestrationTools returns; the values are the names published to the model. Dots are
   dropped from the published name because --allowedTools matches on exact names and a dot there
   is a needless way to be surprised. */
const EXPOSED = [
  ['dispatchTool', 'team_dispatch', 'hand a subtask to a named crew member and wait for its answer'],
  ['spawnTool', 'team_spawn', 'start an ephemeral subagent that inherits this lead\'s identity'],
  ['subagentsTool', 'team_subagents', 'list the background subagents and their state'],
  ['steerTool', 'team_steer', 'send a correction to a running worker'],
  ['interruptTool', 'team_interrupt', 'stop a running worker'],
  ['resumeTool', 'team_resume', 'resume a stalled or interrupted subagent'],
];

// summonTool is NOT here. See the header: adding crew is the Commander's act.
const WITHHELD = ['summonTool'];

function resolveClaudeCrew(opts) {
  const o = opts || {};
  const orch = o.orchestration || null;

  if (!orch || !o.granted) {
    return {
      defs: [],
      published: [],
      allowedTools: [],
      grant: Object.create(null),
      summary: 'crew: ' + (o.granted ? 'no orchestration host' : 'no orchestrator on the floor'),
    };
  }

  const defs = [];
  const published = [];
  const allowedTools = [];
  const grant = Object.create(null);

  for (const [prop, name, why] of EXPOSED) {
    const tool = orch[prop];
    if (!tool || typeof tool.run !== 'function' || !tool.name) continue;
    defs.push({ publishedName: name, tool: tool });
    grant[name] = String(tool.name);
    published.push({
      name: name,
      // The host tool's own description is the honest one; the short why says what it is FOR.
      description: (why ? why + ' — ' : '') + String(tool.description || tool.name),
      inputSchema: (tool.schema && typeof tool.schema === 'object') ? tool.schema : { type: 'object', properties: {} },
    });
    allowedTools.push('mcp__' + SERVER + '__' + name);
  }

  return {
    defs: defs,
    published: published,
    allowedTools: allowedTools,
    grant: grant,
    summary: 'crew: ' + (published.length ? published.map((p) => p.name).join(', ') : 'none')
      + (published.length ? ' (team.summon withheld — adding crew is the Commander\'s)' : ''),
  };
}

module.exports = { resolveClaudeCrew, EXPOSED, WITHHELD, SERVER };
