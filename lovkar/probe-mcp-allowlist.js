/* lovkar/probe-mcp-allowlist.js — can a placed connector be gated by NAME instead of by token?

   probe-mcp-config.js settled the cheap route: the CLI will NOT reuse its own OAuth for a server
   named by URL in --mcp-config, so projecting a placed connector that way would mean writing the
   Commander's access token into a per-run file. Worth avoiding if another shape exists.

   The candidate: inherit every server (no --strict-mcp-config), but pre-approve ONLY the placed
   connector's tools. `--permission-mode dontAsk` refuses anything not pre-approved, so the rest
   are listed but uncallable.

   TWO HALVES, BOTH REQUIRED. The first attempt at this probe reported success on a false
   positive: it judged the allowed half by regex over the model's prose, and the server it named
   happened not to be loaded that run, so "could not call it" was misread as "ran". Membership is
   now read from an explicit tool LISTING, and both halves use servers that are reliably present.

   Allowed half uses Spotify get_currently_playing — no side effect at all. Denied half uses
   Gmail list_labels: read-only, no message content, and Gmail is the refusal that matters.

   Run:  node lovkar/probe-mcp-allowlist.js
*/
'use strict';
const { spawn } = require('child_process');
const path = require('path');

const VAULT = path.join(path.resolve(__dirname, '..'), 'vault');
const ALLOWED = 'mcp__claude_ai_Spotify__get_currently_playing';
const DENIED = 'mcp__claude_ai_Gmail__list_labels';

function run(ask, allowedTools) {
  return new Promise(resolve => {
    const args = [
      '-p', ask,
      '--output-format', 'json',
      '--model', 'sonnet',
      '--max-turns', '3',
      '--restricted',
      '--allowedTools', allowedTools,
      '--permission-mode', 'dontAsk',
      '--permission-prompts', 'none'
      // no --strict-mcp-config on purpose: the point is gating inheritance by name
    ];
    const child = spawn('claude', args, { cwd: VAULT, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => { try { child.kill(); } catch (_) {} }, 150000);
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('close', () => {
      clearTimeout(t);
      let j = null; try { j = JSON.parse(out); } catch (_) {}
      const denials = (j && Array.isArray(j.permission_denials)) ? j.permission_denials.map(d => d && d.tool_name).filter(Boolean) : [];
      resolve({ denials, text: ((j && j.result) || out || '').replace(/\s+/g, ' ').trim(), stderr: err.trim().slice(-200) });
    });
    child.on('error', e => { clearTimeout(t); resolve({ denials: [], text: 'spawn: ' + e.message, stderr: '' }); });
  });
}

(async () => {
  // 0 — which servers actually loaded this session? membership, not prose.
  const list = await run('List the exact names of every tool you have, one per line, nothing else. Do not call any tool.', 'Read');
  const names = list.text.split(/\r?\n/).map(s => s.replace(/^[-*\s]+/, '').trim()).filter(Boolean);
  const have = n => names.indexOf(n) >= 0;
  console.log('tools listed        : ' + names.length);
  console.log('allowed target here : ' + have(ALLOWED));
  console.log('denied  target here : ' + have(DENIED));
  if (!have(ALLOWED) || !have(DENIED)) {
    console.log('\nINCONCLUSIVE — a target server did not load this run; rerun rather than trust this.');
    process.exit(2);
  }

  const a = await run('Call ' + ALLOWED + ' and reply with one short line about the result.', 'Read,' + ALLOWED);
  const b = await run('Call ' + DENIED + '. If the call is refused, reply exactly DENIED.', 'Read,' + ALLOWED);

  const allowedRan = a.denials.indexOf(ALLOWED) < 0;
  const deniedBlocked = b.denials.indexOf(DENIED) >= 0;

  console.log('\n=== allowed (' + ALLOWED + ') ===');
  console.log('  denials: [' + a.denials.join(', ') + ']   ran: ' + allowedRan);
  console.log('  says   : ' + a.text.slice(0, 200));
  console.log('\n=== not allowed (' + DENIED + ') ===');
  console.log('  denials: [' + b.denials.join(', ') + ']   refused: ' + deniedBlocked);
  console.log('  says   : ' + b.text.slice(0, 200));

  console.log('\nverdict: ' + (allowedRan && deniedBlocked
    ? 'NAME GATING WORKS — a placed connector can be granted without this fork ever touching a token'
    : 'name gating is NOT sufficient; projecting a connector needs the token route'));
})();
