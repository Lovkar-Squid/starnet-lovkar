/* lovkar/probe-tool-names.js — are the names in the moat's map the names this CLI actually has?

   NOVA, asked what she could reach, noticed that the run header claimed TodoWrite, BashOutput,
   KillShell and Task while the tools she could actually see were TaskOutput, TaskStop and Agent.
   Either she was wrong or the audit line is. The audit line is the thing the moat is checked with,
   so it has to be the truth.

   Each case names an exact --tools set and asks the run to list what it ended up with. A name that
   the CLI does not know is silently dropped, and a name that brings companions along shows up as
   tools nobody asked for — both matter, because the first makes the audit claim a tool that is not
   there and the second makes the floor grant more than it said.

   Spends a few subscription turns. Run:  node lovkar/probe-tool-names.js
*/
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const VAULT = path.join(REPO, 'vault');
const CLAUDE = process.env.LOVKAR_CLAUDE_EXE || 'claude';
const LIST = 'List the exact names of every tool you have available right now, one per line, nothing else. Do not call any tool.';

function run(tools) {
  return new Promise((resolve) => {
    const args = ['-p', '--output-format', 'json', '--restricted', '--add-dir', VAULT,
      '--tools', tools.join(','), '--strict-mcp-config',
      '--permission-mode', 'dontAsk', '--permission-prompts', 'none'];
    const child = spawn(CLAUDE, args, { cwd: VAULT, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', () => {});
    child.on('error', (e) => resolve([]));
    child.on('close', () => {
      let text = '';
      try { text = String(JSON.parse(out).result || ''); } catch (_) { text = out; }
      resolve(text.split(/[\s,]+/).map((s) => s.replace(/[^A-Za-z0-9_]/g, '')).filter(Boolean));
    });
    child.stdin.write(LIST);
    child.stdin.end();
  });
}

const CASES = [
  ['the real names, on their own', ['Read', 'TaskOutput', 'TaskStop', 'Agent']],
  ['agent without the orchestrator', ['Read', 'Write']],
  ['the vault freebies', ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'TodoWrite']],
  ['the workbench', ['Read', 'Bash', 'BashOutput', 'KillShell']],
  ['the orchestrator', ['Read', 'Task']],
  ['the cabinet', ['Read', 'NotebookEdit']],
  ['the dish', ['Read', 'WebSearch', 'WebFetch']],
];

(async () => {
  console.log('do the names in the map exist in this CLI?\n');
  const missing = [];
  const extra = [];
  for (const [label, asked] of CASES) {
    const got = await run(asked);
    const gone = asked.filter((t) => got.indexOf(t) < 0);
    const unasked = got.filter((t) => asked.indexOf(t) < 0);
    console.log(label);
    console.log('  asked : ' + asked.join(', '));
    console.log('  got   : ' + (got.length ? got.join(', ') : '(nothing)'));
    if (gone.length) { console.log('  DROPPED (named, not there): ' + gone.join(', ')); missing.push(...gone); }
    if (unasked.length) { console.log('  EXTRA (not named, there anyway): ' + unasked.join(', ')); extra.push(...unasked); }
    console.log('');
  }
  const uniq = (a) => a.filter((x, i) => a.indexOf(x) === i);
  console.log('names in the map this CLI does NOT know: ' + (missing.length ? uniq(missing).join(', ') : 'none'));
  console.log('tools that arrive without being named:  ' + (extra.length ? uniq(extra).join(', ') : 'none'));
  process.exit(0);
})();
