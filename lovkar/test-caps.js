/* lovkar/test-caps.js — the moat projection and the vault root, tested without spawning anything.

   These two are pure on purpose: the capability decision and the "where does memory live"
   decision are exactly the places where a silent wrong answer is invisible (a denied tool
   looks like a model that chose not to act; a forked vault looks like an agent that forgot).

   Run:  node lovkar/test-caps.js
*/
'use strict';
const path = require('path');
const { resolveClaudeCaps, capsPrompt, MAP, BASE_TOOLS } = require('../sidecar/runners/claudecode-caps.js');
const { resolveVaultRoot } = require('../sidecar/vault/vault-root.js');

let pass = 0, fail = 0;
function ok(cond, what) { if (cond) { pass++; } else { fail++; console.error('  FAIL: ' + what); } }
function eq(a, b, what) { ok(JSON.stringify(a) === JSON.stringify(b), what + '\n        got      ' + JSON.stringify(a) + '\n        expected ' + JSON.stringify(b)); }

const VAULT = 'D:\\repo\\vault';
const WORK = 'D:\\repo';
const caps = (objects, workdir) => resolveClaudeCaps({ objects, vaultRoot: VAULT, workdir: workdir === undefined ? WORK : workdir });

/* ---- the freebie: an empty room still remembers ---- */
{
  const c = caps([]);
  eq(c.tools, ['Read', 'Glob', 'Grep', 'Write', 'Edit'], 'empty room -> vault freebie only');
  eq(c.cwd, VAULT, 'empty room runs INSIDE the vault, so that is all it can touch');
  eq(c.addDirs, [], 'empty room needs no extra root');
  ok(c.tools.indexOf('Bash') < 0, 'empty room has no shell');
  ok(c.tools.indexOf('WebSearch') < 0, 'empty room has no web');
}

/* ---- one object at a time: the grant must be exactly the object's own ---- */
{
  const c = caps([{ objectType: 'dish' }]);
  ok(c.tools.indexOf('WebSearch') >= 0 && c.tools.indexOf('WebFetch') >= 0, 'dish -> web');
  ok(c.tools.indexOf('Bash') < 0, 'dish does NOT bring the shell along');
  eq(c.cwd, VAULT, 'dish grants no folder reach');
  eq(c.grantedBy.WebSearch, 'dish', 'the grant names the object that made it');
}
{
  const c = caps([{ objectType: 'workbench' }]);
  ok(c.tools.indexOf('Bash') >= 0, 'workbench -> shell');
  ok(c.tools.indexOf('WebSearch') < 0, 'workbench does not bring the web along');
  eq(c.cwd, VAULT, 'a shell does not by itself widen the file boundary');
}
{
  const c = caps([{ objectType: 'cabinet' }]);
  eq(c.cwd, WORK, 'cabinet moves the run into the project folder');
  eq(c.addDirs, [], 'and the vault needs no second root here — it already lives inside the project');
  ok(c.tools.indexOf('NotebookEdit') >= 0, 'cabinet -> the full file set');
}
{
  const c = caps([{ objectType: 'notebook' }]);
  eq(c.cwd, VAULT, 'notebook alone stays vault-only — a diary, not a filing cabinet');
  eq(c.addDirs, [], 'no second root');
}
{
  const c = caps([{ objectType: 'orchestrator' }]);
  ok(c.tools.indexOf('Agent') >= 0, 'orchestrator -> Agent');
}

/* ---- placed but inert: named, never silently dropped ---- */
{
  const c = caps([{ objectType: 'studio' }, { objectType: 'jukebox' }]);
  eq(c.tools, ['Read', 'Glob', 'Grep', 'Write', 'Edit'], 'studio+jukebox grant no Claude Code tool');
  eq(c.unmapped.map(u => u.objectType), ['studio', 'jukebox'], 'and both are reported as inert');
  ok(c.unmapped.every(u => u.why && u.why.length > 10), 'each inert object explains itself');
  ok(/Placed but inert/.test(capsPrompt(c)), 'the prompt tells the agent about them');
}
{
  const c = caps([{ objectType: 'teleporter' }]);
  eq(c.unmapped.map(u => u.objectType), ['teleporter'], 'an unknown object is reported, not ignored');
  eq(c.tools, ['Read', 'Glob', 'Grep', 'Write', 'Edit'], 'and grants nothing');
}

/* ---- combinations, dedup, order ---- */
{
  const c = caps([{ objectType: 'cabinet' }, { objectType: 'dish' }, { objectType: 'workbench' }, { objectType: 'notebook' }]);
  eq(c.tools, ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'NotebookEdit', 'WebSearch', 'WebFetch', 'Bash', 'TaskOutput', 'TaskStop'],
     'the full office, deduped and in a stable order');
  eq(c.cwd, WORK, 'cabinet decides the root');
}
{
  const a = caps([{ objectType: 'dish' }, { objectType: 'dish' }, 'dish']);
  const b = caps([{ objectType: 'dish' }]);
  eq(a.tools, b.tools, 'duplicate placements are idempotent');
  eq(a.placed, ['dish'], 'and the placed list is deduped');
  ok(caps(['workbench']).tools.indexOf('Bash') >= 0, 'a bare string objectType works too');
}
{
  const c = caps([null, undefined, {}, { objectType: '' }, { objectType: 'dish' }]);
  eq(c.placed, ['dish'], 'junk entries are skipped without throwing');
}

/* ---- the vault-inside-workdir case: no redundant second root ---- */
{
  const c = resolveClaudeCaps({ objects: [{ objectType: 'cabinet' }], vaultRoot: 'D:\\repo\\vault', workdir: 'D:\\repo' });
  eq(c.addDirs, [], 'a vault already inside cwd is not added twice');
}
{
  const c = resolveClaudeCaps({ objects: [{ objectType: 'cabinet' }], vaultRoot: 'D:\\repo\\vault', workdir: 'D:\\other' });
  eq(c.addDirs, ['D:\\repo\\vault'], 'a vault outside cwd IS added');
}
{
  const c = resolveClaudeCaps({ objects: [{ objectType: 'cabinet' }], vaultRoot: 'D:/Repo/Vault', workdir: 'd:\\repo' });
  eq(c.addDirs, [], 'containment is case- and separator-insensitive, as Windows is');
}
{
  const c = resolveClaudeCaps({ objects: [{ objectType: 'cabinet' }], vaultRoot: 'D:\\repo-other\\vault', workdir: 'D:\\repo' });
  eq(c.addDirs, ['D:\\repo-other\\vault'], 'a sibling with a shared prefix is NOT treated as inside');
}

/* ---- the prompt is honest about what is missing ---- */
{
  const p = capsPrompt(caps([]));
  ok(/You do NOT have: Bash, WebSearch, WebFetch/.test(p), 'the prompt names the missing powers');
  ok(/workbench = shell/.test(p), 'and says which object would grant them');
  const full = capsPrompt(caps([{ objectType: 'workbench' }, { objectType: 'dish' }]));
  ok(!/You do NOT have/.test(full), 'and says nothing of the sort once they are placed');
}

/* ---- vault root: one memory, whichever copy of the sidecar is running ---- */
{
  const REPO = 'D:\\Claude\\starnet-lovkar';
  const files = {};
  files[path.join(REPO, 'CLAUDE.md')] = true;
  files[path.join(REPO, 'lovkar', 'patch-upstream.js')] = true;
  const fakeFs = { existsSync: p => !!files[p] };

  const fromRepo = resolveVaultRoot({ fs: fakeFs, env: {}, cwd: REPO, dirname: path.join(REPO, 'sidecar', 'vault') });
  const fromRelease = resolveVaultRoot({
    fs: fakeFs, env: {},
    cwd: path.join(REPO, 'src-tauri', 'target', 'release'),
    dirname: path.join(REPO, 'src-tauri', 'target', 'release', 'sidecar', 'vault')
  });
  eq(fromRepo, path.join(REPO, 'vault'), 'dev sidecar finds the repo vault');
  eq(fromRelease, path.join(REPO, 'vault'), 'the PACKAGED sidecar finds the SAME vault — the split is closed');
  eq(fromRepo, fromRelease, 'both copies agree, which is the whole point');

  eq(resolveVaultRoot({ fs: fakeFs, env: { LOVKAR_VAULT_DIR: 'E:\\mem' }, cwd: REPO, dirname: REPO }), path.resolve('E:\\mem'),
     'LOVKAR_VAULT_DIR overrides everything');
  eq(resolveVaultRoot({ fs: { existsSync: () => false }, env: {}, cwd: 'C:\\app', dirname: 'C:\\app\\sidecar\\vault' }), path.join('C:\\app', 'vault'),
     'outside a checkout it falls back to <cwd>/vault');
  eq(resolveVaultRoot({ fs: { existsSync: p => p === path.join(REPO, 'CLAUDE.md') }, env: {}, cwd: 'C:\\app', dirname: path.join(REPO, 'sidecar') }), path.join('C:\\app', 'vault'),
     'a half-marker (CLAUDE.md alone) is NOT a checkout');
}

/* ---- the orchestrator: granted to the lead run, not placed on the floor ---- */
{
  // resolveClaudeCaps only maps what it is given; index.js decides whether a lead run gets one.
  // What must hold HERE is that the object, however it arrives, grants Task and nothing else.
  const withOrch = caps([{ objectType: 'cabinet' }, { objectType: 'orchestrator' }]);
  const without = caps([{ objectType: 'cabinet' }]);
  ok(withOrch.tools.indexOf('Agent') >= 0, 'orchestrator grants Agent');
  ok(without.tools.indexOf('Agent') < 0, 'and without it there is no delegation by any route');
  eq(withOrch.tools.filter(t => without.tools.indexOf(t) < 0), ['Agent'], 'it grants delegation and nothing besides');
  eq(withOrch.cwd, without.cwd, 'and it does not widen the folder boundary');
}

/* ---- the SECOND dial: FULL POWER drops the boundary, never adds a tool ---- */
{
  const off = resolveClaudeCaps({ objects: [], vaultRoot: VAULT, workdir: WORK });
  ok(off.confined === true, 'confined is the DEFAULT');

  const on = resolveClaudeCaps({ objects: [], vaultRoot: VAULT, workdir: WORK, fullPower: true });
  ok(on.confined === false, 'FULL POWER turns the boundary off');
  eq(on.cwd, WORK, 'and starts the run from the project rather than the vault');

  // The property that matters most: authority must never manufacture a capability.
  eq(on.tools, off.tools, 'FULL POWER grants NO extra tool — an empty room is still an empty room');
  ok(on.tools.indexOf('Bash') < 0, 'specifically: no shell appears just because authority is high');
  ok(on.tools.indexOf('WebSearch') < 0, 'and no web either');

  const both = resolveClaudeCaps({ objects: [{ objectType: 'workbench' }], vaultRoot: VAULT, workdir: WORK, fullPower: true });
  ok(both.tools.indexOf('Bash') >= 0, 'a PLACED workbench still grants the shell at full power');
  ok(both.confined === false, 'and it runs unconfined');

  ok(/UNCONFINED/.test(on.summary), 'the log line says so plainly');
  ok(/NO folder boundary/.test(capsPrompt(on)), 'and so does the prompt');
  ok(/refused by the host/.test(capsPrompt(off)), 'while a confined run is told the host enforces it');
}

/* THE NAMES ARE THE CLI'S, AND THEY DRIFT. A tool name the CLI does not know is dropped in
   silence, so a phantom name still GATES correctly — it just makes the audit line claim a tool the
   run never had, which is the one thing an audit line may not do. It cost nothing to find only
   because the agent read its own tool list and said so. These names were measured with
   lovkar/probe-tool-names.js on 2026-09-15; re-run it after a CLI upgrade. A unit test cannot ask
   the CLI anything, so what it can do is refuse to let a known-dead name back in by accident. */
{
  const DEAD = ['TodoWrite', 'BashOutput', 'KillShell', 'Task'];
  const all = []
    .concat(BASE_TOOLS)
    .concat(Object.keys(MAP).reduce((acc, k) => acc.concat((MAP[k] && MAP[k].tools) || []), []));
  for (const dead of DEAD) {
    ok(all.indexOf(dead) < 0, 'no phantom tool name in the map: ' + dead + ' does not exist in this CLI');
  }
  const bench = (MAP.workbench && MAP.workbench.tools) || [];
  ok(bench.indexOf('Bash') >= 0, 'the workbench still grants the shell');
  ok(bench.indexOf('TaskOutput') >= 0 && bench.indexOf('TaskStop') >= 0, 'with the shell companions under their live names');
  ok(((MAP.orchestrator && MAP.orchestrator.tools) || []).indexOf('Agent') >= 0, 'and the orchestrator delegates under its live name');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
