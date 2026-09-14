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

const path = require('path');
const { makeClaudeCodeRunner } = require('./claudecode-runner.js');
const { makeVault } = require('../vault/vault.js');
const { resolveVaultRoot } = require('../vault/vault-root.js');
const { resolveClaudeCaps, capsPrompt } = require('./claudecode-caps.js');
const { sharedRateLimitGate } = require('./ratelimit-gate.js');

const MAX_PROMPT = 60000;

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

    // Visible, once per run, on the sidecar's own log: a capability decision that happens in
    // silence is one nobody can audit — which is exactly how the last one went unnoticed.
    try { console.log('[lovkar] ' + agentId + ' ' + runId + ' | ' + caps.summary); } catch (_) {}

    // The harness's system prompt rides as an append, not a replace: Claude Code's own system
    // prompt is what makes its tools behave, and replacing it would break the thing we came for.
    const appendSystemPrompt = [
      String(o.system || '').trim(),
      capsPrompt(caps),
      o.vault === false ? '' : vault.protocolPrompt(vault.notesDir)
    ].filter(Boolean).join('\n\n');

    let summary = null, failed = null;
    try {
      summary = await runner.run({
        agentId, runId,
        trigger: ['directive', 'schedule', 'event', 'loop', 'nightshift'].indexOf(o.trigger) >= 0 ? o.trigger : 'directive',
        prompt,
        cwd: caps.cwd,
        addDirs: caps.addDirs,
        tools,
        allowedTools: tools,
        // The CLI refuses --restricted together with bypassPermissions, so the two move as one.
        restricted: o.restricted !== false && caps.confined,
        model: o.model && String(o.model).trim() ? String(o.model).trim() : undefined,
        disallowedTools: o.disallowedTools,
        permissionMode: o.permissionMode || (caps.confined ? 'dontAsk' : 'bypassPermissions'),
        appendSystemPrompt,
        emit,
        signal: o.signal,
        shouldNotifyLimit: sharedRateLimitGate().shouldNotify
      });
    } catch (e) {
      failed = (e && e.message) ? e.message : String(e);
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
      caps: { placed: caps.placed, tools: caps.tools, cwd: caps.cwd, addDirs: caps.addDirs, confined: caps.confined, unmapped: caps.unmapped }
    };
  }

  return { runClaudeCodeOnce, vault, vaultRoot, flattenMessages };
}

module.exports = { makeClaudeCodeRunOnce, flattenMessages };
