/* lovkar/probe-permissions.js — WHICH permission-rule spelling does this Claude Code build honour?

   Not a unit test and not part of the suite: it spends real subscription turns. It exists
   because a permission rule that does not match fails SILENTLY as a denial, and a denial is
   indistinguishable from a model that chose not to write. The only honest way to know which
   spelling works is to make the CLI try each one and look at BOTH the filesystem and the CLI's
   own `permission_denials` record afterwards — "the file is not there" alone cannot tell a
   denial apart from a model that never called the tool.

   Reproduces the real desktop case: cwd is the packaged build's directory, so the target path
   the rule must match lies OUTSIDE cwd, exactly as it did when NOVA's write was refused.

   Run:  node lovkar/probe-permissions.js
*/
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const RELEASE = path.join(REPO, 'src-tauri', 'target', 'release');
const VAULT = path.join(REPO, 'vault');
const NOTES = path.join(VAULT, 'notes');
const fwd = p => p.split('\\').join('/');

const CASES = [
  { id: 'rel-in-cwd',   cwd: RELEASE, allow: 'Write(vault/**)',                addDir: null,  target: path.join(RELEASE, 'vault', 'notes', '_probe_rel-in-cwd.md'), rel: 'vault/notes/_probe_rel-in-cwd.md' },
  { id: 'rel-repo-cwd', cwd: REPO,    allow: 'Write(vault/**)',                addDir: null,  target: path.join(NOTES, '_probe_rel-repo-cwd.md'), rel: 'vault/notes/_probe_rel-repo-cwd.md' },
  { id: 'abs-fwd',      cwd: RELEASE, allow: 'Write(' + fwd(VAULT) + '/**)',   addDir: VAULT, target: path.join(NOTES, '_probe_abs-fwd.md') },
  { id: 'abs-dblslash', cwd: RELEASE, allow: 'Write(//' + fwd(VAULT) + '/**)', addDir: VAULT, target: path.join(NOTES, '_probe_abs-dblslash.md') },
  { id: 'abs-back',     cwd: RELEASE, allow: 'Write(' + VAULT + '\\**)',       addDir: VAULT, target: path.join(NOTES, '_probe_abs-back.md') },
  { id: 'bare-adddir',  cwd: RELEASE, allow: 'Write',                          addDir: VAULT, target: path.join(NOTES, '_probe_bare-adddir.md') },
  { id: 'bare-no-add',  cwd: RELEASE, allow: 'Write',                          addDir: null,  target: path.join(NOTES, '_probe_bare-no-add.md') }
];

function run(c) {
  return new Promise(resolve => {
    try { fs.unlinkSync(c.target); } catch (_) {}
    const where = c.rel || fwd(c.target);
    const args = [
      '-p', 'Use the Write tool to create the file ' + where + ' containing exactly the word ok. Do not read or list anything first. Then reply DONE.',
      '--output-format', 'json',
      '--model', 'sonnet',
      '--max-turns', '4',
      '--allowedTools', 'Read,' + c.allow,
      '--permission-mode', 'dontAsk',
      '--permission-prompts', 'none'
    ];
    if (c.addDir) args.push('--add-dir', c.addDir);

    // spawn(cmd, argv) — never a command string. PowerShell's array-joining is what truncated
    // a prompt to its first word on the first spike of this fork. 'claude' resolves to the
    // NATIVE claude.exe here; naming claude.cmd instead earns EINVAL on Node >= 20.
    const child = spawn('claude', args, { cwd: c.cwd, env: process.env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill(); } catch (_) {} }, 150000);
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('close', () => {
      clearTimeout(timer);
      const wrote = fs.existsSync(c.target);
      let j = null; try { j = JSON.parse(out); } catch (_) {}
      const denials = (j && Array.isArray(j.permission_denials)) ? j.permission_denials.map(d => d && d.tool_name).filter(Boolean) : [];
      resolve({
        id: c.id, allow: c.allow, addDir: !!c.addDir, wrote,
        denials,
        say: (j && typeof j.result === 'string' ? j.result : out).replace(/\s+/g, ' ').trim().slice(0, 160),
        tail: (err || '').trim().slice(-160)
      });
      if (wrote) { try { fs.unlinkSync(c.target); } catch (_) {} }
    });
    child.on('error', e => { clearTimeout(timer); resolve({ id: c.id, allow: c.allow, addDir: !!c.addDir, wrote: false, denials: [], say: 'spawn: ' + e.message, tail: '' }); });
  });
}

(async () => {
  try { fs.mkdirSync(path.join(RELEASE, 'vault', 'notes'), { recursive: true }); } catch (_) {}
  try { fs.mkdirSync(NOTES, { recursive: true }); } catch (_) {}
  const results = await Promise.all(CASES.map(run));
  console.log('\nrepo  = ' + REPO);
  console.log('vault = ' + VAULT + '\n');
  for (const r of results) {
    const verdict = r.wrote ? 'ALLOWED ' : r.denials.length ? 'DENIED  ' : 'no-call ';
    console.log('  ' + verdict + '| ' + r.id.padEnd(13) + ' | addDir=' + (r.addDir ? 'y' : 'n') + ' | ' + r.allow);
    console.log('             denials=[' + r.denials.join(',') + '] says: ' + r.say);
    if (r.tail) console.log('             stderr: ' + r.tail);
  }
  const win = results.filter(r => r.wrote).map(r => r.id);
  console.log('\nworks: ' + (win.length ? win.join(', ') : 'NONE'));
})();
