/* lovkar/patch-index.js — the entire index.js footprint of this fork, in one reviewable script.

   index.js is the merge hotfile. Rather than hand-edit it (and lose track of what we changed
   when rebasing onto upstream), every change lives here: three anchored insertions, each
   asserted to match EXACTLY ONCE, idempotent, syntax-checked afterwards.

   Run:  node lovkar/patch-index.js          (apply)
         node lovkar/patch-index.js --check  (report only)
*/
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const repo = path.resolve(__dirname, '..');
const target = path.join(repo, 'sidecar', 'index.js');
const checkOnly = process.argv.includes('--check');

const MARK = 'LOVKAR:claude-code';

const PATCHES = [
  {
    what: 'require the route module',
    anchor: "const { makeEmitter } = require('../shared/emitter.js');",
    add: "\n/* " + MARK + " */ const { makeLovkarRun } = require('./routes/lovkar-run.js');"
  },
  {
    what: 'construct the route (needs chanEmit, so it lands right after it)',
    anchor: "const chanEmit = (name, payload) => { try { return chanEmitValidated(name, redact(payload)); } catch (_) {} };",
    add: "\n/* " + MARK + " */ const lovkarRun = makeLovkarRun({ chanEmit, cwd: process.cwd() });"
  },
  {
    what: 'register POST /api/lovkar/run',
    anchor: "  { m: 'POST', exact: '/api/run', h: handleRun, errorPolicy: runFailPolicy },",
    add: "\n  /* " + MARK + " */ { m: 'POST', exact: '/api/lovkar/run', h: (req, res) => lovkarRun.handle(req, res) },"
  }
];

let src = fs.readFileSync(target, 'utf8');
const before = src;

if (src.indexOf(MARK) >= 0) {
  console.log('already patched (' + MARK + ' present) — nothing to do');
  process.exit(0);
}

let problems = 0;
for (const p of PATCHES) {
  const n = src.split(p.anchor).length - 1;
  if (n !== 1) {
    console.error('✗ anchor matched ' + n + ' times (need exactly 1): ' + p.what);
    console.error('  ' + p.anchor.slice(0, 90));
    problems++;
    continue;
  }
  console.log('✓ anchor ok: ' + p.what);
  if (!checkOnly) src = src.replace(p.anchor, p.anchor + p.add);
}

if (problems) { console.error('\n' + problems + ' anchor(s) failed — upstream moved. Nothing written.'); process.exit(1); }
if (checkOnly) { console.log('\n--check: all anchors present, nothing written'); process.exit(0); }

const backup = target + '.pre-lovkar';
if (!fs.existsSync(backup)) fs.writeFileSync(backup, before);
fs.writeFileSync(target, src);

try {
  execFileSync(process.execPath, ['--check', target], { stdio: 'pipe' });
  console.log('\n✅ patched and syntax-clean (' + PATCHES.length + ' insertions, backup at ' + path.basename(backup) + ')');
} catch (e) {
  fs.writeFileSync(target, before);
  console.error('\n❌ syntax check failed, reverted:\n' + String(e.stderr || e.message));
  process.exit(1);
}
