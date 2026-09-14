/* lovkar/patch-upstream.js — every line this fork adds to an upstream file, in one script.

   Supersedes lovkar/patch-index.js (which covered index.js only, before the provider profile
   and the runOnce branch existed).

   Upstream files are hand-edited NOWHERE. Each one is restored from a pristine `.pre-lovkar`
   backup and re-patched from scratch, which makes this idempotent by construction: run it
   twice, run it after a rebase, run it after someone poked the file — the result is the same
   and always reflects exactly what is written here.

   Anchors are ALWAYS single-line: a multi-line anchor depends on the file's line endings and
   silently stops matching the moment a checkout normalises them.

   Run:  node lovkar/patch-upstream.js            (apply)
         node lovkar/patch-upstream.js --check    (verify anchors, write nothing)
         node lovkar/patch-upstream.js --revert    (restore upstream, remove the backups)
*/
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const repo = path.resolve(__dirname, '..');
const mode = process.argv.includes('--revert') ? 'revert'
           : process.argv.includes('--check') ? 'check'
           : 'apply';

const M = '/* LOVKAR:claude-code */';

const FILES = [
  {
    file: 'sidecar/index.js',
    patches: [
      {
        what: 'require the route and the runOnce adapter',
        anchor: "const { makeEmitter } = require('../shared/emitter.js');",
        add: "\n" + M + " const { makeLovkarRun } = require('./routes/lovkar-run.js');"
           + "\n" + M + " const { makeClaudeCodeRunOnce } = require('./runners/claudecode-runonce.js');"
      },
      {
        what: 'construct both (chanEmit must already exist)',
        anchor: "const chanEmit = (name, payload) => { try { return chanEmitValidated(name, redact(payload)); } catch (_) {} };",
        add: "\n" + M + " const lovkarRun = makeLovkarRun({ chanEmit, cwd: process.cwd() });"
           + "\n" + M + " const lovkarRunOnce = makeClaudeCodeRunOnce({ cwd: process.cwd() });"
      },
      {
        what: 'register POST /api/lovkar/run',
        anchor: "  { m: 'POST', exact: '/api/run', h: handleRun, errorPolicy: runFailPolicy },",
        add: "\n  " + M + " { m: 'POST', exact: '/api/lovkar/run', h: (req, res) => lovkarRun.handle(req, res) },"
      },
      {
        /* The important one. It sits at the very TOP of runOnce, before the concurrency gate
           and the workspace lease, so returning here releases nothing that was never taken.
           A Claude Code run brings its own loop, tools and permission model; none of the host
           runOnce assembles below applies to it. */
        what: 'short-circuit runOnce for the claude-code provider',
        // Single-line anchor on purpose: a multi-line one is hostage to CRLF vs LF. This line
        // sits immediately after the frozen-state check, so the branch lands after it.
        anchor: "  const { key, system: rawSystem, messages = [], agentId = 'agent', signal, runId } = o;",
        add: "\n  " + M + " {\n"
           + "    const _lovkarProv = normalizeProvider(o.provider || ((agentRoster.get(String(o.agentId || '')) || {}).provider) || '');\n"
           + "    if (_lovkarProv === 'claude-code') return lovkarRunOnce.runClaudeCodeOnce(o);\n"
           + "  }"
      }
    ]
  },
  {
    file: 'sidecar/providers/registry.js',
    patches: [
      {
        what: 'add the claude-code provider profile',
        anchor: '  const PROFILES = [',
        add: "\n    {\n"
           + "      // LOVKAR:claude-code - a Claude subscription, no API key. Modelled on the `codex` profile: sign-in\n"
           + "      // rather than a key, and unmetered. It deliberately has NO case in providers/factory.js —\n"
           + "      // runOnce short-circuits to the Claude Code runner instead, because no adapter can satisfy a\n"
           + "      // one-turn transport seam for something that owns its own agent loop.\n"
           + "      id: 'claude-code',\n"
           + "      aliases: ['claudecode', 'claude-max', 'anthropic-oauth'],\n"
           + "      name: 'Claude (subscription)',\n"
           + "      label: 'CLAUDE CODE',\n"
           + "      endpoint: 'Claude Code CLI, local',\n"
           + "      blurb: 'sign in, no API key',\n"
           + "      live: true,\n"
           + "      adapter: 'claude-code',\n"
           + "      authType: 'cli_login',\n"
           + "      keyRequired: false,\n"
           + "      unmetered: true,\n"
           + "      credentialPool: false,\n"
           + "      supportsTools: true,\n"
           + "      supportsReasoning: true,\n"
           + "      order: 5\n"
           + "    },"
      }
    ]
  }
];

function backupPath(abs) { return abs + '.pre-lovkar'; }

function restoreOrSnapshot(abs) {
  const bak = backupPath(abs);
  if (fs.existsSync(bak)) { fs.writeFileSync(abs, fs.readFileSync(bak)); return 'restored'; }
  fs.writeFileSync(bak, fs.readFileSync(abs));
  return 'snapshotted';
}

if (mode === 'revert') {
  let n = 0;
  for (const f of FILES) {
    const abs = path.join(repo, f.file);
    const bak = backupPath(abs);
    if (fs.existsSync(bak)) { fs.writeFileSync(abs, fs.readFileSync(bak)); fs.unlinkSync(bak); n++; console.log('reverted ' + f.file); }
    else console.log('no backup for ' + f.file + ' (already upstream?)');
  }
  console.log('\n' + n + ' file(s) back to upstream');
  process.exit(0);
}

let problems = 0;
const staged = [];

for (const f of FILES) {
  const abs = path.join(repo, f.file);
  if (!fs.existsSync(abs)) { console.error('missing: ' + f.file); problems++; continue; }

  const bak = backupPath(abs);
  const pristine = fs.existsSync(bak) ? fs.readFileSync(bak, 'utf8') : fs.readFileSync(abs, 'utf8');
  let src = pristine;

  console.log('\n' + f.file);
  for (const p of f.patches) {
    const n = src.split(p.anchor).length - 1;
    if (n !== 1) {
      console.error('  x anchor matched ' + n + ' times (need exactly 1): ' + p.what);
      problems++;
      continue;
    }
    console.log('  + ' + p.what);
    src = src.replace(p.anchor, p.anchor + p.add);
  }
  staged.push({ abs, src, rel: f.file });
}

if (problems) { console.error('\n' + problems + ' anchor problem(s) — upstream moved. Nothing written.'); process.exit(1); }
if (mode === 'check') { console.log('\n--check: every anchor present and unique, nothing written'); process.exit(0); }

for (const s of staged) {
  restoreOrSnapshot(s.abs);
  fs.writeFileSync(s.abs, s.src);
}

let bad = 0;
for (const s of staged) {
  try { execFileSync(process.execPath, ['--check', s.abs], { stdio: 'pipe' }); }
  catch (e) {
    bad++;
    fs.writeFileSync(s.abs, fs.readFileSync(backupPath(s.abs)));
    console.error('\nx syntax check failed for ' + s.rel + ', reverted:\n' + String(e.stderr || e.message));
  }
}
if (bad) process.exit(1);

const total = FILES.reduce((n, f) => n + f.patches.length, 0);
console.log('\nOK - ' + total + ' insertions across ' + FILES.length + ' files, all syntax-clean');
