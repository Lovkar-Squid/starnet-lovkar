/* lovkar/probe-mcp-config.js — can a placed connector reach a run WITHOUT handling the token?

   THE DESIGN QUESTION. Wiring `connector` objects to --mcp-config needs each server to
   authenticate. The obvious route is to read the Commander's OAuth tokens out of StarNet's
   connector store and write them into a per-run config file. That works, and it puts live
   account tokens on disk through this fork's code, which is a cost worth avoiding.

   The alternative costs nothing IF it works: Claude Code already holds its own OAuth for the
   very same servers (`claude mcp list` shows them connected). If naming a server by URL alone
   in --mcp-config makes the CLI reuse that stored credential, then a placed connector can be
   projected into a run with no token ever passing through here.

   Measured, not assumed. Three cases:
     A  --mcp-config naming the server by URL only, + --strict-mcp-config
     B  the same without --strict-mcp-config (does the named one authenticate either way?)
     C  --strict-mcp-config alone, no config — the control: nothing must appear

   Run:  node lovkar/probe-mcp-config.js
*/
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VAULT = path.join(path.resolve(__dirname, '..'), 'vault');
const ASK = 'List the exact names of every tool you have available right now, one per line, nothing else. Do not call any tool.';

// One server, by URL only — no headers, no token, nothing secret in this file.
const CONFIG = { mcpServers: { moj_server: { type: 'http', url: 'https://mcp.lovkarsquid.com/mcp' } } };
const cfgPath = path.join(os.tmpdir(), 'lovkar-mcp-probe.json');

function run(label, extra) {
  return new Promise(resolve => {
    const args = [
      '-p', ASK,
      '--output-format', 'json',
      '--model', 'sonnet',
      '--max-turns', '2',
      '--restricted',
      '--tools', 'Read',
      '--allowedTools', 'Read',
      '--permission-mode', 'dontAsk',
      '--permission-prompts', 'none'
    ].concat(extra);

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
      const mine = names.filter(n => /moj|lovkarsquid|run_command|read_file|list_dir|server_status|write_file|audit/i.test(n));
      resolve({ label, total: names.length, mine, sample: names.slice(0, 25), stderr: err.trim().slice(-300) });
    });
    child.on('error', e => { clearTimeout(t); resolve({ label, total: 0, mine: [], sample: [], stderr: 'spawn: ' + e.message }); });
  });
}

(async () => {
  fs.writeFileSync(cfgPath, JSON.stringify(CONFIG, null, 2));
  console.log('config (no secrets): ' + JSON.stringify(CONFIG));

  const rows = [];
  rows.push(await run('A  --mcp-config + --strict-mcp-config', ['--mcp-config', cfgPath, '--strict-mcp-config']));
  rows.push(await run('B  --mcp-config, not strict', ['--mcp-config', cfgPath]));
  rows.push(await run('C  strict only, no config (control)', ['--strict-mcp-config']));

  for (const r of rows) {
    console.log('\n=== ' + r.label + ' ===');
    console.log('  tools reported : ' + r.total);
    console.log('  from MY server : ' + (r.mine.length ? r.mine.join(', ') : '(none)'));
    console.log('  sample         : ' + r.sample.join(' | ').slice(0, 260));
    if (r.stderr) console.log('  stderr: ' + r.stderr);
  }
  try { fs.unlinkSync(cfgPath); } catch (_) {}

  console.log('\nverdict: ' + (rows[0].mine.length
    ? 'the CLI reuses its own OAuth — a placed connector can be projected with NO token handled here'
    : 'no reuse — projecting a connector would require passing the Commander\'s token into the run'));
})();
