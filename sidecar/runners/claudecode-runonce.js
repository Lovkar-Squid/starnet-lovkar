/* sidecar/runners/claudecode-runonce.js — the runOnce-compatible entry point.

   runOnce() is the harness's run HOST: it assembles a tool registry, a capability
   projection, a consent broker, a provider and a cost engine, then drives loop.js. None of
   that applies to a Claude Code run, which arrives with its own loop, its own tools and its
   own permission model. So the `claude-code` provider id short-circuits at the very top of
   runOnce — before the concurrency gate, the workspace lease or anything else that would
   have to be released — and lands here instead.

     runClaudeCodeOnce(o, deps) -> Promise<result>

   `o` is runOnce's own options object; `result` is shaped like runAgentLoop's return so the
   callers that read it (handleRun, the hub, the cron driver) need no special case.

   The events go out on o.emit, which is whatever sink the caller owns — NDJSON for the
   browser, an assembler for the hub. Same names, same payloads as a native run, so the
   station renders it identically.

   WHAT THE SHORT-CIRCUIT MUST NOT DROP (the 2026-09-14 regression, found by the agent itself
   and written up in vault/notes/claude-code-runs-ignore-room-tools.md): skipping the host also
   skipped THE MOAT, so the room's objects and the authority setting decided nothing and one
   hardcoded tool list applied to every run. `o.placedObjects` now carries the room in, and
   claudecode-caps.js turns it into the actual --tools/--restricted gate. A run must never
   again grant more — or less — than what is on the floor.

   LIMITATION, stated rather than hidden: multi-turn history is flattened into the prompt.
   Claude Code keeps its own session and `--resume <id>` would carry context properly; wiring
   that means threading a session id through the run record, which is its own change.
*/
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeClaudeCodeRunner } = require('./claudecode-runner.js');
const { makeVault } = require('../vault/vault.js');
const { makeProposals } = require('../vault/proposals.js');
const { resolveVaultRoot } = require('../vault/vault-root.js');
const { resolveClaudeCaps, capsPrompt } = require('./claudecode-caps.js');
const { resolveClaudeMcp } = require('./claudecode-mcp.js');
const { resolveLocalMcp } = require('./claudecode-local-mcp.js');
const { sharedGrants } = require('../routes/lovkar-mcp-grants.js');
const { sharedRateLimitGate } = require('./ratelimit-gate.js');

const MAX_PROMPT = 60000;
// The per-run connector bridge, resolved from THIS file so the packaged copy finds its own.
const BRIDGE = path.join(__dirname, '..', 'mcp', 'lovkar-bridge.js');
// The Commander's list of local stdio MCP servers. It sits in the workspace dir beside the save
// (a SIBLING of the agent's fs jail, never inside it) because it names commands that will be
// executed: the agent must not be able to write its own entry.
const LOCAL_REGISTRY = 'lovkar-local-mcp.json';
function readLocalRegistry(dir) {
  if (!dir) return null;
  try { return JSON.parse(fs.readFileSync(path.join(dir, LOCAL_REGISTRY), 'utf8')); }
  catch (_) { return null; }   // absent or unreadable means no local servers, never a crash
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(b => (b && typeof b === 'object' && typeof b.text === 'string') ? b.text : '').filter(Boolean).join('\n');
  }
  return '';
}

/* Flatten the conversation into one prompt. Prior turns are labelled and fenced so the model
   reads them as transcript rather than as fresh instructions — the same data/instruction
   discipline the vault uses. */
function flattenMessages(messages) {
  const msgs = Array.isArray(messages) ? messages : [];
  const useful = msgs.filter(m => m && (m.role === 'user' || m.role === 'assistant') && textOf(m.content).trim());
  if (!useful.length) return '';
  const last = useful[useful.length - 1];
  const prior = useful.slice(0, -1);
  if (!prior.length) return textOf(last.content).slice(0, MAX_PROMPT);
  const head = prior.map(m => (m.role === 'user' ? 'USER: ' : 'ASSISTANT: ') + textOf(m.content).trim()).join('\n\n');
  return [
    'Earlier turns of this conversation, for context only:',
    '<<<TRANSCRIPT_BEGIN>>>',
    head.split('<<<TRANSCRIPT_BEGIN>>>').join('').split('<<<TRANSCRIPT_END>>>').join(''),
    '<<<TRANSCRIPT_END>>>',
    '',
    'Current request:',
    textOf(last.content).trim()
  ].join('\n').slice(0, MAX_PROMPT);
}

function makeClaudeCodeRunOnce(deps) {
  deps = deps || {};
  const cwd = deps.cwd || process.cwd();
  const runner = makeClaudeCodeRunner({ claudePath: deps.claudePath, spawn: deps.spawn });
  // ONE vault for every copy of this sidecar. Derived from the checkout rather than from cwd,
  // because the packaged desktop build runs from src-tauri/target/release and used to keep a
  // second, invisible memory there.
  const vaultRoot = deps.vaultRoot ? path.resolve(deps.vaultRoot) : resolveVaultRoot({ cwd });
  const vault = makeVault({ root: vaultRoot });
  try { vault.init(); } catch (_) {}
  // An agent may PROPOSE a room or an object into the vault; only the Commander places it.
  const proposals = makeProposals({ root: vaultRoot });

  async function runClaudeCodeOnce(o) {
    o = o || {};
    const startedAt = Date.now();
    const emit = typeof o.emit === 'function' ? o.emit : function () {};
    const agentId = String(o.agentId || 'agent');
    const runId = String(o.runId || ('run_' + startedAt.toString(36)));
    const prompt = flattenMessages(o.messages);

    if (!prompt.trim()) {
      emit('agent.run.start', { agentId, runId, trigger: 'directive', model: 'claude-code' });
      emit('agent.run.end', { agentId, runId, reason: 'empty', turns: 0, usd: 0 });
      return { reason: 'empty', messages: o.messages || [], usd: 0, turns: 0 };
    }

    /* THE MOAT. o.placedObjects is the agent's real room, read off the durable save by the
       caller — never from prompt text or model output, which is the whole point. An explicit
       o.allowedTools still wins, so a test or an internal caller can pin a set. */
    const caps = resolveClaudeCaps({
      objects: o.placedObjects || [],
      vaultRoot,
      workdir: o.workdir || cwd,
      fullPower: !!o.fullPower
    });
    const tools = o.allowedTools ? [].concat(o.allowedTools) : caps.tools;

    /* THE SAME FLOOR, PROJECTED ONTO CONNECTORS. o.connectorDefs is upstream's own per-agent
       projection (connectors.toolDefsForObjects over this agent's room), handed in by the caller
       so this fork can never disagree with the station about what a placed portal grants. The
       grant is minted here and revoked in the finally below: it lives exactly as long as the run.
       Measured gate (lovkar/probe-mcp-stdio.js): --mcp-config decides which servers exist and
       --allowedTools decides which of their tools may be called; --tools does not reach MCP at all. */
    /* LOCAL stdio servers (Roblox Studio, Blender, windows-mcp). These do NOT go through the
       connector manager — upstream refuses host stdio there, four layers deep, and that refusal
       is left exactly as it is. The CLI spawns these itself from the per-run config, and they are
       gated by the rule in claudecode-local-mcp.js: the Commander listed the agent, the run is at
       FULL POWER, and the floor already granted it a shell. */
    const local = resolveLocalMcp({
      registry: readLocalRegistry(o.workspacesDir),
      agentId: agentId,
      tools: tools,
      fullPower: !!o.fullPower,
    });

    const grants = o.grants || sharedGrants();
    let grantId = null;
    let mcp = { servers: null, allowedTools: [], grant: {}, published: [], summary: 'connectors: none' };
    if (o.mcpUrl && Array.isArray(o.connectorDefs) && o.connectorDefs.length) {
      const shape = resolveClaudeMcp({ defs: o.connectorDefs, bridgePath: BRIDGE, url: o.mcpUrl, grantId: 'pending' });
      if (shape.published.length) {
        grantId = grants.mint(runId, {
          agentId: agentId,
          fullPower: !!o.fullPower,
          // the CONNECTOR reading of the floor — the route re-derives live defs from exactly this,
          // so the capability list (studio, dish, workbench…) would publish nothing at all
          objects: o.connectorObjects || [],
          allow: shape.grant,
          published: shape.published,
        });
        if (grantId) mcp = resolveClaudeMcp({ defs: o.connectorDefs, bridgePath: BRIDGE, url: o.mcpUrl, grantId: grantId, logFile: path.join(vaultRoot, '_bridge.log') });
      }
    }

    // Visible, once per run, on the sidecar's own log: a capability decision that happens in
    // silence is one nobody can audit — which is exactly how the last one went unnoticed.
    /* THE AUDIT LINE. A capability decision nobody can read is one nobody can check, and the
       sidecar runs as a child of the desktop app whose stdout goes nowhere — so this also lands in
       a file. It records what the floor granted THIS run: the built-in tools, the folder boundary,
       and the connectors. Appended, capped, and inside the vault (which is gitignored), so it never
       travels with the fork. */
    const _lovkarLine = '[lovkar] ' + agentId + ' ' + runId + ' | ' + caps.summary + ' | ' + mcp.summary + (mcp.servers ? ' | bridge: declared' : ' | bridge: none') + ' | ' + local.summary;
    try { console.log(_lovkarLine); } catch (_) {}
    try {
      const auditFile = path.join(vaultRoot, '_runs.log');
      try { if (fs.statSync(auditFile).size > 262144) fs.unlinkSync(auditFile); } catch (_) {}
      fs.appendFileSync(auditFile, new Date(startedAt).toISOString() + ' ' + _lovkarLine + '\n');
    } catch (_) {}

    // The harness's system prompt rides as an append, not a replace: Claude Code's own system
    // prompt is what makes its tools behave, and replacing it would break the thing we came for.
    const appendSystemPrompt = [
      String(o.system || '').trim(),
      capsPrompt(caps),
      o.vault === false ? '' : vault.protocolPrompt(vault.notesDir),
      o.vault === false || o.proposals === false ? '' : proposals.promptBlock(agentId)
    ].filter(Boolean).join('\n\n');

    /* The system prompt goes to a file and the prompt down stdin — see the header of
       claudecode-runner.js for the 40482-character argv that made this necessary. The file is this
       run's alone and is removed in the finally below, whatever happens. */
    let mcpFile = null;
    const allServers = Object.assign({}, mcp.servers || {}, local.servers || {});
    if (Object.keys(allServers).length) {
      try {
        mcpFile = path.join(os.tmpdir(), 'lovkar-mcp-' + String(runId).replace(/[^a-zA-Z0-9_-]/g, '') + '-' + startedAt.toString(36) + '.json');
        fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: allServers }), { mode: 0o600 });
      } catch (_) { mcpFile = null; }   // no config file means no servers at all, never a half-open door
    }
    let sysFile = null;
    if (appendSystemPrompt) {
      try {
        sysFile = path.join(os.tmpdir(), 'lovkar-sys-' + String(runId).replace(/[^a-zA-Z0-9_-]/g, '') + '-' + startedAt.toString(36) + '.txt');
        fs.writeFileSync(sysFile, appendSystemPrompt, { mode: 0o600 });
      } catch (_) { sysFile = null; }   // fall back to the inline flag rather than lose the prompt
    }

    let summary = null, failed = null;
    try {
      summary = await runner.run({
        agentId, runId,
        trigger: ['directive', 'schedule', 'event', 'loop', 'nightshift'].indexOf(o.trigger) >= 0 ? o.trigger : 'directive',
        prompt,
        cwd: caps.cwd,
        addDirs: caps.addDirs,
        tools,
        // --tools gates the built-ins; the MCP names ride in --allowedTools, which is the only
        // thing that makes a connector tool callable under dontAsk.
        allowedTools: mcpFile ? tools.concat(mcp.allowedTools, local.allowedTools) : tools,
        mcpConfig: mcpFile || undefined,
        // The CLI refuses --restricted together with bypassPermissions, so the two move as one.
        restricted: o.restricted !== false && caps.confined,
        strictMcp: o.strictMcp !== false,          // never inherit the Commander's own MCP servers
        model: o.model && String(o.model).trim() ? String(o.model).trim() : undefined,
        disallowedTools: o.disallowedTools,
        permissionMode: o.permissionMode || (caps.confined ? 'dontAsk' : 'bypassPermissions'),
        promptViaStdin: true,
        appendSystemPromptFile: sysFile || undefined,
        appendSystemPrompt: sysFile ? undefined : appendSystemPrompt,
        emit,
        signal: o.signal,
        shouldNotifyLimit: sharedRateLimitGate().shouldNotify
      });
    } catch (e) {
      failed = (e && e.message) ? e.message : String(e);
    } finally {
      if (sysFile) { try { fs.unlinkSync(sysFile); } catch (_) {} }
      if (mcpFile) { try { fs.unlinkSync(mcpFile); } catch (_) {} }
      if (grantId) { try { grants.revoke(grantId); } catch (_) {} }
    }

    const endedAt = Date.now();
    const text = summary ? summary.text : '';
    const messages = (o.messages || []).concat(text ? [{ role: 'assistant', content: text }] : []);

    return {
      reason: failed ? 'error' : 'done',
      messages,
      usd: 0,                       // a subscription run has no per-run bill; the gauge is utilization
      turns: summary ? summary.turns : 0,
      text,
      model: summary ? summary.model : 'claude-code',
      sessionId: summary ? summary.sessionId : '',
      artifacts: [],
      toolsOk: !failed,
      toolTrace: [],
      startedAt, endedAt,
      durationMs: endedAt - startedAt,
      parentRunId: o.parentRunId || '',
      error: failed || undefined,
      unmetered: true,
      caps: { placed: caps.placed, tools: caps.tools, cwd: caps.cwd, addDirs: caps.addDirs, confined: caps.confined, unmapped: caps.unmapped },
      connectors: { tools: mcp.allowedTools, summary: mcp.summary },
      localMcp: { granted: local.granted, refused: local.refused, summary: local.summary }
    };
  }

  return { runClaudeCodeOnce, vault, vaultRoot, flattenMessages };
}

module.exports = { makeClaudeCodeRunOnce, flattenMessages };
