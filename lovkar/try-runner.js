/* lovkar/try-runner.js — live end-to-end proof of the Phase 1 runner.

   Spawns a REAL Claude Code run on the subscription and prints every U.bus event the
   translator produces, live, validating each one against the frozen contract as it goes.
   This is what the station will receive.

   Run:  node lovkar/try-runner.js "your prompt"
*/
'use strict';
const path = require('path');
const os = require('os');
const fs = require('fs');

const repo = path.resolve(__dirname, '..');
const events = require(path.join(repo, 'shared', 'events.js'));
const { makeClaudeCodeRunner } = require(path.join(repo, 'sidecar', 'runners', 'claudecode-runner.js'));

const prompt = process.argv[2] || 'Read package.json and reply with the name and version on one short line.';

// resolve the binary: PATH may not carry ~/.local/bin in this process yet
function resolveClaude() {
  const home = os.homedir();
  const guesses = [
    path.join(home, '.local', 'bin', 'claude.exe'),
    path.join(home, '.local', 'bin', 'claude')
  ];
  for (const g of guesses) if (fs.existsSync(g)) return g;
  return 'claude';
}

const runner = makeClaudeCodeRunner({ claudePath: resolveClaude() });

let n = 0, bad = 0;
const counts = {};
const t0 = Date.now();

function emit(name, payload) {
  n++; counts[name] = (counts[name] || 0) + 1;
  const v = events.validate(name, payload);
  if (!v.ok) { bad++; console.log('  ✗ INVALID ' + name + ' ' + JSON.stringify(v.errors)); }
  const ms = String(Date.now() - t0).padStart(6);
  if (name === 'agent.token') { process.stdout.write(payload.delta); return; }
  let extra = '';
  if (name === 'agent.tool_call') extra = payload.name + ' ' + payload.argsSummary;
  else if (name === 'agent.tool_result') extra = (payload.ok ? 'ok' : 'ERR') + ' ' + (payload.ms != null ? payload.ms + 'ms ' : '') + (payload.summary || '');
  else if (name === 'agent.reasoning') extra = payload.on ? 'on' : 'off';
  else if (name === 'agent.run.start') extra = payload.model + ' / ' + payload.trigger;
  else if (name === 'agent.run.end') extra = payload.reason + ' turns=' + payload.turns + ' usd=' + payload.usd;
  else if (name === 'agent.cost') extra = 'in=' + payload.tokensIn + ' out=' + payload.tokensOut + ' cached=' + payload.cachedTokens + ' think=' + payload.reasoningTokens;
  else if (name === 'notify') extra = String(payload);
  console.log('\n[' + ms + 'ms] ' + name.padEnd(20) + extra);
}

(async () => {
  console.log('prompt: ' + prompt + '\ncwd:    ' + repo + '\n' + '-'.repeat(70));
  const r = await runner.run({
    agentId: 'lovkar-1', runId: 'run_' + Date.now(), trigger: 'directive',
    prompt, cwd: repo,
    allowedTools: ['Read', 'Glob'],
    permissionMode: 'dontAsk',
    emit
  });
  console.log('\n' + '-'.repeat(70));
  console.log('events: ' + n + '   invalid: ' + bad + '   badLines: ' + r.badLines);
  for (const k of Object.keys(counts).sort()) console.log('   ' + String(counts[k]).padStart(4) + '  ' + k);
  console.log('exit=' + r.exitCode + ' signal=' + r.signal + ' session=' + r.sessionId + ' turns=' + r.turns + ' tools=' + r.toolCalls);
  if (r.stderr) console.log('stderr: ' + r.stderr);
  console.log(bad === 0 ? '\n✅ LIVE PASS' : '\n❌ ' + bad + ' invalid events');
  process.exit(bad === 0 ? 0 : 1);
})().catch(e => { console.error('RUNNER ERROR: ' + e.message); process.exit(1); });
