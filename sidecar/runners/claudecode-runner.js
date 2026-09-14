/* sidecar/runners/claudecode-runner.js — the IO shell around claudecode-translate.js.

   Spawns Claude Code in headless streaming mode, splits its NDJSON stdout into objects,
   feeds them to the PURE translator, and emits the resulting U.bus events. All policy
   lives in the translator; everything here is process plumbing.

     makeClaudeCodeRunner({ spawn, clock, claudePath }) -> { run(opts) -> Promise<summary> }

   WHY spawn takes an ARGUMENT ARRAY and this module never builds a command STRING:
   PowerShell's Start-Process joins an array with spaces and does not quote, which silently
   truncated `-p` to its first word on the very first spike — a run that still produced a
   perfectly valid stream and a confidently wrong answer. child_process.spawn(cmd, argv)
   escapes each argument itself, on Windows too. Never reintroduce a shell here: no
   `shell: true`, no string concatenation, no cmd /c.

   AUTH: the subscription login in ~/.claude/.credentials.json is inherited from the
   environment, so `env` is passed through untouched by default and `--bare` is NEVER
   added — bare mode does not read OAuth credentials at all and would silently demand an
   API key. That single flag is the difference between running on the subscription and
   not running at all.
*/
'use strict';
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory();
  else { root.SK = root.SK || {}; root.SK.runners = root.SK.runners || {}; root.SK.runners.claudecodeRunner = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const translate = (typeof require === 'function')
    ? require('./claudecode-translate.js')
    : (globalThis.SK && globalThis.SK.runners && globalThis.SK.runners.claudecodeTranslate);

  const STDERR_KEEP = 4000;

  function buildArgs(o) {
    const a = ['-p', String(o.prompt == null ? '' : o.prompt),
               '--output-format', 'stream-json',
               '--verbose',
               '--include-partial-messages'];
    if (o.model) a.push('--model', String(o.model));
    if (o.resume) a.push('--resume', String(o.resume));
    if (Number.isFinite(o.maxTurns)) a.push('--max-turns', String(o.maxTurns));
    if (o.allowedTools && o.allowedTools.length) a.push('--allowedTools', [].concat(o.allowedTools).join(','));
    // NOTE (phase 2): --allowedTools PRE-APPROVES, it does not restrict; read-only tools run
    // regardless. Real capability gating needs the deny side, which is why it is a first-class
    // option here rather than an afterthought.
    if (o.disallowedTools && o.disallowedTools.length) a.push('--disallowedTools', [].concat(o.disallowedTools).join(','));
    if (o.mcpConfig) a.push('--mcp-config', String(o.mcpConfig));
    a.push('--permission-mode', String(o.permissionMode || 'dontAsk'));
    a.push('--permission-prompts', 'none');   // unattended: nothing here can answer a prompt
    if (o.appendSystemPrompt) a.push('--append-system-prompt', String(o.appendSystemPrompt));
    return a;
  }

  function makeClaudeCodeRunner(deps) {
    deps = deps || {};
    const spawn = deps.spawn || (typeof require === 'function' ? require('child_process').spawn : null);
    const clock = deps.clock || Date.now;
    const claudePath = deps.claudePath || 'claude';

    function run(opts) {
      opts = opts || {};
      const emit = typeof opts.emit === 'function' ? opts.emit : function () {};
      const tr = translate.makeTranslator({
        agentId: opts.agentId, runId: opts.runId,
        trigger: opts.trigger, model: opts.model
      });

      return new Promise(function (resolve, reject) {
        if (!spawn) { reject(new Error('no spawn available')); return; }

        let child;
        try {
          child = spawn(claudePath, buildArgs(opts), {
            cwd: opts.cwd,
            env: opts.env || process.env,
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe']
          });
        } catch (e) { reject(e); return; }

        let buf = '';
        let err = '';
        let settled = false;
        let badLines = 0;

        function flushEvents(list) {
          for (const e of list) {
            try { emit(e.name, e.payload); }
            catch (ex) { /* a listener throwing must never kill the run */ }
          }
        }

        function onLine(line) {
          line = line.trim();
          if (!line) return;
          let o = null;
          try { o = JSON.parse(line); }
          catch (e) { badLines++; return; }   // a partial/garbage line is dropped, never thrown
          flushEvents(tr.ingest(o, clock()));
        }

        child.stdout.setEncoding('utf8');
        child.stdout.on('data', function (chunk) {
          buf += chunk;
          let i;
          while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); onLine(line); }
        });

        child.stderr.setEncoding('utf8');
        child.stderr.on('data', function (chunk) { if (err.length < STDERR_KEEP) err += chunk; });

        function finalize(code, signal) {
          if (settled) return;
          settled = true;
          if (buf.trim()) onLine(buf);            // last line may arrive without a newline
          buf = '';
          flushEvents(tr.finish({ code, signal }));
          const s = tr.state();
          resolve({
            sessionId: s.sessionId, model: s.model, turns: s.turns,
            text: s.text, toolCalls: s.toolCalls,
            exitCode: code, signal: signal || null,
            stderr: err.trim(), badLines
          });
        }

        child.on('error', function (e) {
          if (settled) return;
          settled = true;
          flushEvents(tr.finish({ code: null, signal: null }));
          reject(e);
        });
        child.on('close', finalize);

        if (opts.signal) {
          if (opts.signal.aborted) { try { child.kill(); } catch (e) {} }
          else opts.signal.addEventListener('abort', function () { try { child.kill(); } catch (e) {} }, { once: true });
        }
      });
    }

    return { run, buildArgs };
  }

  return { makeClaudeCodeRunner, buildArgs };
});
