/* lovkar/probe-mcp-leak.js — do the Commander's OWN MCP servers leak into a station run?

   THE QUESTION THAT MATTERS. `--tools` gates the BUILT-IN tools, and that is what the moat
   projection relies on. MCP servers are configured elsewhere (~/.claude.json, not a settings
   file), so `--restricted` does not necessarily exclude them. If a headless run inherits the
   Commander's connected servers, then an agent with an EMPTY room could still send mail,
   read Drive, or run a shell on the home server — with no object on the floor granting it.
   That is not a small gap; it is the moat with a hole in the bottom.

   This asks the CLI itself, under the exact flags a station run uses, and prints what it says
   it has. Then it repeats with --strict-mcp-config to confirm that flag is the fix.

   Run:  node lovkar/probe-mcp-leak.js
*/
'use strict';
const { spawn } = require('child_process');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const VAULT = path.join(REPO, 'vault');

const ASK = 'List the exact names of every tool you have available right now, one per line, nothing else. Do not call any tool.';

function run(label, extra) {
  return new Promise(resolve => {
    const args = [
      '-p', ASK,
      '--output-format', 'json',
      '--model', 'sonnet',
      '--max-turns', '2',
      '--restricted',
      '--tools', 'Read,Glob,Grep,Write,Edit,TodoWrite',
      '--allowedTools', 'Read,Glob,Grep,Write,Edit,TodoWrite',
      '--permission-mode', 'dontAsk',
      '--permission-prompts', 'none'
    ].concat(extra || []);

    const child = spawn('claude', args, { cwd: VAULT, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => { try { child.kill(); } catch (_) {} }, 150000);
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('close', () => {
      clearTimeout(t);
      let j = null; try { j = JSON.parse(out); } catch (_) {}
      const text = (j && typeof j.result === 'string') ? j.result : out;
      const names = text.split(/\r?\n/).map(s => s.replace(/^[-*\s]+/, '').trim()).filter(Boolean);
      const mcp = names.filter(n => /^mcp__/i.test(n) || /gmail|drive|calendar|spotify|3daistudio|wordpress|moj/i.test(n));
      resolve({ label, total: names.length, mcp, sample: names.slice(0, 40), stderr: err.trim().slice(-200) });
    });
    child.on('error', e => { clearTimeout(t); resolve({ label, total: 0, mcp: [], sample: [], stderr: 'spawn: ' + e.message }); });
  });
}

(async () => {
  const a = await run('as station runs today', []);
  const b = await run('with --strict-mcp-config', ['--strict-mcp-config']);
  for (const r of [a, b]) {
    console.log('\n=== ' + r.label + ' ===');
    console.log('  tools reported: ' + r.total);
    console.log('  MCP-looking   : ' + (r.mcp.length ? r.mcp.join(', ') : '(none)'));
    console.log('  sample        : ' + r.sample.join(' | ').slice(0, 400));
    if (r.stderr) console.log('  stderr: ' + r.stderr);
  }
  console.log('\nverdict: ' + (a.mcp.length
    ? 'LEAK — the Commander\'s own MCP servers reach a station run with nothing placed on the floor'
    : 'clean — no MCP server reaches a station run by default'));
})();
