/* sidecar/runners/claudecode-runner.js — the IO shell around claudecode-translate.js.

   Spawns Claude Code in headless streaming mode, splits its NDJSON stdout into objects,
   feeds them to the PURE translator, and emits the resulting U.bus events. All policy
   lives in the translator and in claudecode-caps.js; everything here is process plumbing.

     makeClaudeCodeRunner({ spawn, clock, claudePath }) -> { run(opts) -> Promise<summary> }

   WHY spawn takes an ARGUMENT ARRAY and this module never builds a command STRING:
   PowerShell's Start-Process joins an array with spaces and does not quote, which silently
   truncated `-p` to its first word on the very first spike — a run that still produced a
   perfectly valid stream and a confidently wrong answer. child_process.spawn(cmd, argv)
   escapes each argument itself, on Windows too. Never reintroduce a shell here: no
   `shell: true`, no string concatenation, no cmd /c. (`claudePath` must also name the NATIVE
   claude.exe rather than a .cmd shim — Node >= 20 refuses to spawn .cmd without a shell and
   fails with EINVAL.)

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

  /* THE GATE, and why it is spelled this way.

     The obvious spelling does not work. Measured against this CLI build with
     lovkar/probe-permissions.js (7 cases), a path-qualified allow rule — `Write(vault/**)`,
     `Write(D:/…/vault/**)`, the `//` absolute prefix, backslashes, with and without
     --add-dir — is refused EVERY time; only the bare tool name grants. That is precisely the
     bug that denied NOVA her own memory on 2026-09-14 while the config looked correct.

     So the gate is built from the two knobs that were measured to work
     (lovkar/probe-restricted.js, 5 cases including the escapes that must fail):

       --tools       the built-in tools that EXIST for this run. Anything not named is gone,
                     not merely unapproved — a model cannot argue its way to a tool that was
                     never registered.
       --restricted  confines the file tools to cwd + every --add-dir, refuses
                     bypassPermissions, and ignores user/project settings files so a stray
                     ~/.claude/settings.json cannot widen a run behind the Commander's back.
       --allowedTools  the same names again, so nothing stops to ask for approval that
                       nobody is there to give.

     --permission-mode dontAsk + --permission-prompts none is the unattended posture: no
     prompt can be answered, so anything not granted above is denied rather than hanging. */
  /* THE PROMPT AND THE SYSTEM PROMPT NEVER RIDE ON THE COMMAND LINE.

     Windows CreateProcess caps a command line at 32767 characters. The first version passed both
     `-p <prompt>` and `--append-system-prompt <text>` as argv, which worked for weeks and then
     stopped: a real COMMS thread grew to 28 messages with a 10 KB system prompt, the argv reached
     40482 characters, spawn failed with ENAMETOOLONG, and the station showed `RUN COMPLETE · 0s`
     with no error anywhere — a silent ceiling that scaled with how much the agent had been used.

     So the prompt goes down STDIN (bare `-p`, the documented pipe form) and the system prompt goes
     in a file (`--append-system-prompt-file`). Both measured against this build before adopting.
     Unconditionally, not past some size threshold: a threshold is the same cliff moved. */
  function buildArgs(o) {
    const a = ['-p'];
    if (!o.promptViaStdin) a.push(String(o.prompt == null ? '' : o.prompt));
    a.push('--output-format', 'stream-json',
           '--verbose',
           '--include-partial-messages');
    if (o.model) a.push('--model', String(o.model));
    if (o.resume) a.push('--resume', String(o.resume));
    if (Number.isFinite(o.maxTurns)) a.push('--max-turns', String(o.maxTurns));

    if (o.restricted !== false) a.push('--restricted');
    if (o.tools && o.tools.length) a.push('--tools', [].concat(o.tools).join(','));
    if (o.allowedTools && o.allowedTools.length) a.push('--allowedTools', [].concat(o.allowedTools).join(','));
    if (o.disallowedTools && o.disallowedTools.length) a.push('--disallowedTools', [].concat(o.disallowedTools).join(','));
    for (const d of (o.addDirs || [])) { if (d) a.push('--add-dir', String(d)); }

    if (o.mcpConfig) a.push('--mcp-config', String(o.mcpConfig));
    /* THE HOLE IN THE BOTTOM OF THE MOAT, closed. --tools gates the BUILT-IN tools; MCP servers
       are configured in ~/.claude.json, which is not a settings file, so --restricted does not
       exclude them and a headless run INHERITS every server the Commander connected in their own
       CLI. Measured (lovkar/probe-mcp-leak.js): a run with an empty room reported 65 tools
       including Gmail send_message, against 5 with this flag. An agent could have mailed from a
       floor with nothing on it. Connectors must arrive through --mcp-config because a `connector`
       object was PLACED - never by inheritance. */
    if (o.strictMcp !== false) a.push('--strict-mcp-config');
    a.push('--permission-mode', String(o.permissionMode || 'dontAsk'));
    a.push('--permission-prompts', 'none');   // unattended: nothing here can answer a prompt
    if (o.appendSystemPromptFile) a.push('--append-system-prompt-file', String(o.appendSystemPromptFile));
    else if (o.appendSystemPrompt) a.push('--append-system-prompt', String(o.appendSystemPrompt));
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
        trigger: opts.trigger, model: opts.model,
        shouldNotifyLimit: opts.shouldNotifyLimit
      });

      return new Promise(function (resolve, reject) {
        if (!spawn) { reject(new Error('no spawn available')); return; }

        let child;
        try {
          child = spawn(claudePath, buildArgs(opts), {
            cwd: opts.cwd,
            env: opts.env || process.env,
            windowsHide: true,
            stdio: [opts.promptViaStdin ? 'pipe' : 'ignore', 'pipe', 'pipe']
          });
        } catch (e) { reject(e); return; }

        if (opts.promptViaStdin) {
          try {
            child.stdin.on('error', function () {});   // a child that died early must not crash the host
            child.stdin.write(String(opts.prompt == null ? '' : opts.prompt));
            child.stdin.end();
          } catch (e) { /* the close handler reports the real outcome */ }
        }

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
