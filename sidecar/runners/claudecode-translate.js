/* sidecar/runners/claudecode-translate.js — PURE stream-json → U.bus translation.

   Claude Code (`claude -p --output-format stream-json --verbose --include-partial-messages`)
   owns its OWN agent loop, so it does not fit providers/provider.js (that seam is one model
   turn at a time). It slots in one level up instead: this module turns Claude Code's NDJSON
   into the frozen shared/events.js events the station already renders, so frontend/ needs
   ZERO changes.

     makeTranslator({ agentId, runId, trigger, model }) -> {
       ingest(obj, nowMs?) -> [{ name, payload }, …]     // one stream-json object in
       finish({ code, signal }?) -> [{ name, payload }]  // process died with no result line
       state() -> { sessionId, model, turns, text, sawResult }
     }

   PURE: no IO, no ambient clock. `nowMs` is injected per call and only ever produces the
   OPTIONAL `ms` field on agent.tool_result — omit it and the output is byte-identical
   minus that field, which is what the fixture tests do.

   REQUIRES `--include-partial-messages`. Without it there are no stream_event lines and
   the only content is the aggregated `assistant` messages; we deliberately IGNORE those
   (they repeat what the deltas already carried) rather than double-emit.

   Contract notes, all learned from real dumps (see lovkar/FAZA-0-MAPPING.md):
     · content_block_start(tool_use) carries index + id + name — same field names as the
       provider seam's tool_start. Args arrive as input_json_delta.partial_json fragments
       and are concatenated, exactly like loop.js accumulates them by index.
     · thinking blocks carry a `signature`. shared/events.js has no place to put one, so
       Phase 1 emits only agent.reasoning on/off and keeps the block text out of the bus.
       Do NOT route thinking through agent.token — that stream is the delivered answer.
     · rate_limit_event has no home in the frozen contract. It rides `notify` (a bare
       string) until the subscription gauge lands; adding a typed event is an ADDITIVE
       change for that phase, never a rename.
*/
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { root.SK = root.SK || {}; root.SK.runners = root.SK.runners || {}; root.SK.runners.claudecodeTranslate = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ARGS_CLIP = 160;
  const SUMMARY_CLIP = 200;

  function clip(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n) + '…' : s;
  }
  function int(n) { const v = Number(n); return Number.isFinite(v) ? Math.round(v) : 0; }
  function num(n) { const v = Number(n); return Number.isFinite(v) ? v : 0; }

  // tool_result content is either a string or an array of {type:'text',text} blocks.
  function resultText(c) {
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) return c.map(b => (b && typeof b.text === 'string') ? b.text : '').join('');
    return '';
  }

  function pct(x) { return Math.round(num(x) * 100); }

  function makeTranslator(opts) {
    opts = opts || {};
    const agentId = String(opts.agentId || 'agent');
    const runId = String(opts.runId || 'run');
    const trigger = String(opts.trigger || 'directive');

    let model = String(opts.model || 'claude-code');
    let sessionId = '';
    let started = false;
    let sawResult = false;
    let turns = 0;
    let thinkingOpen = false;
    let text = '';
    let toolCalls = 0;

    const blocks = new Map();     // content-block index -> { kind, id, name, args }
    const callStart = new Map();  // tool_use id -> nowMs when the call was announced
    const callName = new Map();   // tool_use id -> tool name (for the result summary)

    let lastStopReason = null;
    let lastUsage = null;

    function startEvents() {
      if (started) return [];
      started = true;
      return [{ name: 'agent.run.start', payload: { agentId, runId, trigger, model } }];
    }

    function onStreamEvent(ev, nowMs) {
      const out = [];
      if (!ev || typeof ev !== 'object') return out;

      if (ev.type === 'message_start') { turns++; return out; }

      if (ev.type === 'content_block_start') {
        const cb = ev.content_block || {};
        const idx = int(ev.index);
        if (cb.type === 'tool_use') {
          blocks.set(idx, { kind: 'tool_use', id: String(cb.id || ''), name: String(cb.name || 'tool'), args: '' });
        } else if (cb.type === 'thinking') {
          blocks.set(idx, { kind: 'thinking' });
          if (!thinkingOpen) { thinkingOpen = true; out.push({ name: 'agent.reasoning', payload: { agentId, runId, on: true } }); }
        } else {
          blocks.set(idx, { kind: 'text' });
        }
        return out;
      }

      if (ev.type === 'content_block_delta') {
        const d = ev.delta || {};
        const b = blocks.get(int(ev.index));
        if (d.type === 'text_delta') {
          const delta = String(d.text == null ? '' : d.text);
          if (delta) { text += delta; out.push({ name: 'agent.token', payload: { agentId, runId, delta } }); }
        } else if (d.type === 'input_json_delta') {
          if (b && b.kind === 'tool_use') b.args += String(d.partial_json == null ? '' : d.partial_json);
        }
        // thinking_delta / signature_delta: deliberately swallowed (see header).
        return out;
      }

      if (ev.type === 'content_block_stop') {
        const idx = int(ev.index);
        const b = blocks.get(idx);
        blocks.delete(idx);
        if (!b) return out;
        if (b.kind === 'thinking' && thinkingOpen) {
          thinkingOpen = false;
          out.push({ name: 'agent.reasoning', payload: { agentId, runId, on: false } });
        } else if (b.kind === 'tool_use') {
          toolCalls++;
          const callId = b.id || ('call_' + idx);
          callName.set(callId, b.name);
          if (typeof nowMs === 'number') callStart.set(callId, nowMs);
          out.push({
            name: 'agent.tool_call',
            payload: { agentId, runId, callId, name: b.name, argsSummary: clip(b.args, ARGS_CLIP) }
          });
        }
        return out;
      }

      if (ev.type === 'message_delta') {
        const d = ev.delta || {};
        if (d.stop_reason) lastStopReason = String(d.stop_reason);
        if (ev.usage) lastUsage = ev.usage;
        return out;
      }

      return out;
    }

    // tool_result blocks ride back on a `user` message.
    function onUserMessage(o, nowMs) {
      const out = [];
      const content = (o && o.message && Array.isArray(o.message.content)) ? o.message.content : [];
      for (const c of content) {
        if (!c || c.type !== 'tool_result') continue;
        const callId = String(c.tool_use_id || '');
        const isError = c.is_error === true;
        const payload = {
          agentId, runId, callId,
          ok: !isError,
          isError,
          summary: clip((callName.get(callId) || '') + ': ' + resultText(c.content).replace(/\s+/g, ' ').trim(), SUMMARY_CLIP)
        };
        if (typeof nowMs === 'number' && callStart.has(callId)) {
          payload.ms = Math.max(0, nowMs - callStart.get(callId));
          callStart.delete(callId);
        }
        out.push({ name: 'agent.tool_result', payload });
      }
      return out;
    }

    /* Subscription pressure. Claude Code reports BOTH unified windows live, so this is the
       honest replacement for a USD ledger on a subscription run: the money number is a
       client-side estimate, the utilization is the thing that actually stops you. */
    function onRateLimit(o) {
      const info = (o && o.rate_limit_info) || {};
      const w = info.unifiedWindows || {};
      const five = w.five_hour ? pct(w.five_hour.utilization) : null;
      const seven = w.seven_day ? pct(w.seven_day.utilization) : null;
      const parts = [];
      if (five != null) parts.push('5h ' + five + '%');
      if (seven != null) parts.push('7d ' + seven + '%');
      if (info.isUsingOverage === true) parts.push('OVERAGE');
      if (!parts.length) return [];
      const warn = info.status && info.status !== 'allowed';
      return [{ name: 'notify', payload: (warn ? '⚠ subscription ' : 'subscription ') + parts.join(' · ') }];
    }

    /* result → the money event and the terminal. `reconciled: true` is a literal in the
       frozen schema, and this IS reconciled: the number is Claude Code's own accounting of
       the run, not our estimate from token counts. */
    function onResult(o) {
      const out = [];
      sawResult = true;
      const u = o.usage || lastUsage || {};
      const det = u.output_tokens_details || {};
      const usd = num(o.total_cost_usd);

      out.push({
        name: 'agent.cost',
        payload: {
          agentId, runId, usd, reconciled: true, model,
          tokensIn: int(u.input_tokens) + int(u.cache_creation_input_tokens),
          tokensOut: int(u.output_tokens),
          reasoningTokens: int(det.thinking_tokens),
          cachedTokens: int(u.cache_read_input_tokens)
        }
      });

      const stop = String(o.stop_reason || lastStopReason || '');
      const sub = String(o.subtype || '');
      const term = String(o.terminal_reason || '');
      let reason = 'done';
      let finishReason = null;

      if (o.is_error === true || sub.indexOf('error_during') === 0) reason = 'error';
      else if (sub === 'error_max_turns' || term === 'max_turns') reason = 'max_iters';
      else if (term === 'cancelled' || term === 'interrupted' || stop === 'cancelled') reason = 'cancelled';
      else if (stop === 'refusal') reason = 'refusal';
      else if (!text.trim() && toolCalls === 0) reason = 'empty';

      if (stop === 'max_tokens' || stop === 'length') finishReason = 'length';
      else if (stop === 'content_filter') finishReason = 'content_filter';

      const payload = { agentId, runId, reason, turns: int(o.num_turns || turns), usd };
      if (finishReason) payload.finishReason = finishReason;
      out.push({ name: 'agent.run.end', payload });
      return out;
    }

    function ingest(o, nowMs) {
      if (!o || typeof o !== 'object') return [];
      let out = [];

      if (o.type === 'system' && o.subtype === 'init') {
        if (o.session_id) sessionId = String(o.session_id);
        if (o.model) model = String(o.model);
        return startEvents();
      }
      // A run can open with rate_limit_event BEFORE system/init (seen in every dump), so the
      // start event is emitted lazily by whichever line arrives first that carries a model.
      if (o.type === 'rate_limit_event') return onRateLimit(o);

      if (o.session_id && !sessionId) sessionId = String(o.session_id);

      if (o.type === 'stream_event') { out = startEvents().concat(onStreamEvent(o.event, nowMs)); return out; }
      if (o.type === 'user') return onUserMessage(o, nowMs);
      if (o.type === 'result') return startEvents().concat(onResult(o));

      // 'assistant' repeats the deltas; 'system/status' and 'system/thinking_tokens' are noise here.
      return [];
    }

    /* The process died without a result line — a crash, a kill, a broken pipe. The station
       must never be left with a run that started and never ended, so synthesize the pair. */
    function finish(exit) {
      if (sawResult) return [];
      exit = exit || {};
      const ev = startEvents();
      const killed = exit.signal != null;
      const msg = killed
        ? ('claude exited on signal ' + exit.signal)
        : ('claude exited with code ' + (exit.code == null ? 'unknown' : exit.code) + ' before reporting a result');
      ev.push({ name: 'agent.run.error', payload: { agentId, runId, message: msg, transient: killed } });
      ev.push({
        name: 'agent.run.end',
        payload: { agentId, runId, reason: killed ? 'cancelled' : 'error', turns: int(turns), usd: 0 }
      });
      sawResult = true;
      return ev;
    }

    function state() { return { sessionId, model, turns, text, sawResult, toolCalls }; }

    return { ingest, finish, state };
  }

  return { makeTranslator, clip };
});
