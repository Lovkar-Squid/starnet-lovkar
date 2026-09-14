/* sidecar/routes/lovkar-run.js — POST /api/lovkar/run

   Phase 1 wiring: drive a Claude Code run on the Commander's SUBSCRIPTION and put its
   events on the same durable SSE bus the station already listens to, so the pixel-art
   floor animates with no frontend change at all.

   Deliberately a SEPARATE route from /api/run rather than a branch inside runOnce:
   index.js is the merge hotfile (CODE_MAP says so outright), and phase 1 needs no part of
   runOnce's machinery — no provider, no capability gate, no consent broker, because Claude
   Code brings its own loop and its own tools. Folding into runOnce is phase 2's job, once
   StarNet's tools arrive over MCP and the gate actually has something to gate.

   The index.js footprint is three lines: one require, one construction, one route entry.

     makeLovkarRun({ chanEmit, claudePath, cwd, spawn }) -> { handle(req, res) }

   Response is NDJSON, one {name,payload} per line, mirroring exactly what went on the bus,
   so a caller can watch a run without opening the browser.
*/
'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { makeClaudeCodeRunner } = require('../runners/claudecode-runner.js');

const MAX_BODY = 1 << 16;
const MAX_PROMPT = 8000;

function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => {
      n += c.length;
      if (n > cap) { reject(new Error('body too large')); try { req.destroy(); } catch (_) {} return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* Resolve the Claude Code binary. The native installer puts it in ~/.local/bin, which is
   NOT on PATH until the user opens a new terminal — and the sidecar may well have been
   started from the old one. Look there before trusting PATH. */
function resolveClaudePath(explicit) {
  if (explicit) return explicit;
  if (process.env.LOVKAR_CLAUDE_PATH) return process.env.LOVKAR_CLAUDE_PATH;
  const home = os.homedir();
  for (const g of [path.join(home, '.local', 'bin', 'claude.exe'), path.join(home, '.local', 'bin', 'claude')]) {
    try { if (fs.existsSync(g)) return g; } catch (_) {}
  }
  return 'claude';
}

function makeLovkarRun(deps) {
  deps = deps || {};
  const chanEmit = typeof deps.chanEmit === 'function' ? deps.chanEmit : function () {};
  const defaultCwd = deps.cwd || process.cwd();
  const runner = makeClaudeCodeRunner({
    spawn: deps.spawn,
    claudePath: resolveClaudePath(deps.claudePath)
  });

  const inflight = new Map();   // runId -> AbortController

  async function handle(req, res) {
    let body;
    try { body = JSON.parse(await readBody(req, MAX_BODY) || '{}'); }
    catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad json' }));
      return;
    }

    const prompt = String(body.prompt == null ? '' : body.prompt).slice(0, MAX_PROMPT).trim();
    if (!prompt) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'empty prompt' }));
      return;
    }

    const agentId = String(body.agentId || 'lovkar-1');
    const runId = String(body.runId || ('run_' + Date.now().toString(36)));
    const ac = new AbortController();
    inflight.set(runId, ac);

    res.writeHead(200, {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no'
    });

    // One emit, two destinations: the durable bus (station animates) and this response
    // (caller watches). chanEmit validates against the frozen contract and redacts; a
    // throw there must never take the run down, hence the swallow.
    function emit(name, payload) {
      try { chanEmit(name, payload); } catch (_) {}
      try { res.write(JSON.stringify({ name, payload }) + '\n'); } catch (_) {}
    }

    res.on('close', () => { try { ac.abort(); } catch (_) {} });

    let summary = null, failure = null;
    try {
      summary = await runner.run({
        agentId, runId,
        trigger: body.trigger || 'directive',
        prompt,
        cwd: body.cwd || defaultCwd,
        model: body.model,
        allowedTools: body.allowedTools || ['Read', 'Glob', 'Grep'],
        disallowedTools: body.disallowedTools,
        maxTurns: body.maxTurns,
        permissionMode: body.permissionMode || 'dontAsk',
        emit,
        signal: ac.signal
      });
    } catch (e) {
      failure = e && e.message ? e.message : String(e);
      // the translator already synthesised run.error/run.end on a spawn failure path;
      // this line is the caller-facing detail, not a second bus event.
    } finally {
      inflight.delete(runId);
    }

    try {
      res.write(JSON.stringify({
        name: '_summary',
        payload: failure ? { runId, error: failure } : {
          runId,
          sessionId: summary.sessionId, model: summary.model, turns: summary.turns,
          toolCalls: summary.toolCalls, exitCode: summary.exitCode,
          badLines: summary.badLines, stderr: summary.stderr || undefined
        }
      }) + '\n');
    } catch (_) {}
    try { res.end(); } catch (_) {}
  }

  function cancel(runId) {
    const ac = inflight.get(runId);
    if (!ac) return false;
    try { ac.abort(); } catch (_) {}
    return true;
  }

  return { handle, cancel, inflight };
}

module.exports = { makeLovkarRun, resolveClaudePath };
