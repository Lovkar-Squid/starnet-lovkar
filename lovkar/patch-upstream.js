/* lovkar/patch-upstream.js — every line this fork adds to an upstream file, in one script.

   Upstream files are hand-edited NOWHERE. Each is restored from a pristine `.pre-lovkar`
   backup and re-patched from scratch, which makes this idempotent by construction: run it
   twice, run it after a rebase, run it after someone poked a file — the result is the same
   and always reflects exactly what is written here.

   Anchors are ALWAYS single-line: a multi-line anchor depends on the file's line endings and
   silently stops matching the moment a checkout normalises them.

   `add` appends after the anchor. `replaceWith` swaps the anchor line itself, for the cases
   where the change is INSIDE an expression rather than beside it.

   Run:  node lovkar/patch-upstream.js            (apply)
         node lovkar/patch-upstream.js --check    (verify anchors, write nothing)
         node lovkar/patch-upstream.js --revert   (restore upstream, drop the backups)
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

/* Both frontend files carry their OWN hardcoded provider normalizer whose default arm is
   'openrouter'. Without this line every claude-code selection silently became an OpenRouter
   one — key box, model list and all. */
const NORM_ANCHOR = "    if (p === 'anthropic' || p === 'claude') return 'anthropic';";
const NORM_ADD = "\n    " + M + " if (p === 'claude-code' || p === 'claudecode' || p === 'claude-max' || p === 'anthropic-oauth') return 'claude-code';";

const FILES = [
  {
    file: 'sidecar/index.js',
    patches: [
      {
        what: 'require the route and the runOnce adapter',
        anchor: "const { makeEmitter } = require('../shared/emitter.js');",
        add: "\n" + M + " const { makeLovkarRun } = require('./routes/lovkar-run.js');"
           + "\n" + M + " const { makeLovkarStatus } = require('./routes/lovkar-status.js');"
           + "\n" + M + " const { makeClaudeCodeRunOnce } = require('./runners/claudecode-runonce.js');"
      },
      {
        what: 'construct both (chanEmit must already exist)',
        anchor: "const chanEmit = (name, payload) => { try { return chanEmitValidated(name, redact(payload)); } catch (_) {} };",
        add: "\n" + M + " const lovkarRun = makeLovkarRun({ chanEmit, cwd: process.cwd() });"
           + "\n" + M + " const lovkarStatus = makeLovkarStatus({});"
           + "\n" + M + " const lovkarRunOnce = makeClaudeCodeRunOnce({ cwd: process.cwd() });"
      },
      {
        what: 'register POST /api/lovkar/run',
        anchor: "  { m: 'POST', exact: '/api/run', h: handleRun, errorPolicy: runFailPolicy },",
        add: "\n  " + M + " { m: 'POST', exact: '/api/lovkar/run', h: (req, res) => lovkarRun.handle(req, res) },"
           + "\n  " + M + " { m: 'GET', exact: '/api/lovkar/status', h: (req, res) => lovkarStatus.handle(req, res) },"
      },
      {
        /* The important one. It sits at the very top of runOnce, before the concurrency gate
           and the workspace lease, so returning here releases nothing that was never taken.
           A Claude Code run brings its own loop, tools and permission model; none of the host
           that runOnce assembles below applies to it. */
        what: 'short-circuit runOnce for the claude-code provider',
        anchor: "  const { key, system: rawSystem, messages = [], agentId = 'agent', signal, runId } = o;",
        add: "\n  " + M + " {\n"
           + "    const _lovkarProv = normalizeProvider(o.provider || ((agentRoster.get(String(o.agentId || '')) || {}).provider) || '');\n"
           + "    if (_lovkarProv === 'claude-code') return lovkarRunOnce.runClaudeCodeOnce(o);\n"
           + "  }"
      },
      {
        /* The catalog route would otherwise hand back an empty list (it swallows the adapter
           error by design), leaving the model dropdown blank. These are Claude Code's own
           aliases, which go straight through to --model. */
        what: 'serve a static model list for claude-code',
        anchor: "  if (!getProviderProfile(id)) return json(404, { models: [], error: 'unknown provider' });",
        add: "\n  " + M + " if (id === 'claude-code') {"
           + "\n    // Claude Code aliases. The `[1m]` suffix is a real variant selector, verified against the"
           + "\n    // CLI: `opus` reports claude-opus-5 while `opus[1m]` reports claude-opus-5[1m]. The window"
           + "\n    // is DERIVED from that marker rather than typed twice, so the two can never disagree."
           + "\n    const win = a => (/\\[1m\\]$/.test(a) ? 1000000 : 200000);"
           + "\n    const mk = (a, n) => ({ id: a, name: n + (/\\[1m\\]$/.test(a) ? ' (1M)' : ''), context_length: win(a), max_completion_tokens: null, supportsTools: true });"
           + "\n    return json(200, { provider: id, models: ["
           + "\n      mk('sonnet[1m]', 'Claude Sonnet'), mk('opus[1m]', 'Claude Opus'),"
           + "\n      mk('sonnet', 'Claude Sonnet'), mk('opus', 'Claude Opus'), mk('haiku', 'Claude Haiku')"
           + "\n    ] });"
           + "\n  }"
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
           + "      // LOVKAR:claude-code - a Claude subscription, no API key. Modelled on the `codex` profile:\n"
           + "      // sign-in rather than a key, and unmetered. It deliberately has NO case in providers/factory.js -\n"
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
  },
  {
    file: 'frontend/app/app.js',
    patches: [
      { what: 'teach normalizeProviderId about claude-code', anchor: NORM_ANCHOR, add: NORM_ADD },
      {
        what: 'label claude-code in the provider map',
        anchor: "      codex: 'GPT',",
        add: "\n      'claude-code': 'CLAUDE',   " + M
      },
      {
        /* Without this the card opens on the OpenRouter fallback (gpt 5.5), which this
           provider cannot run. The [1m] variant is the point: plain 'sonnet' is the 200k
           model, 'sonnet[1m]' is the million-token one. Sonnet rather than Opus because a
           station runs many agents against one subscription allowance. */
        what: "default claude-code to sonnet[1m]",
        anchor: "    const list = FALLBACK_MODELS[p] || FALLBACK_MODELS.openrouter;",
        replaceWith: "    if (p === 'claude-code') return 'sonnet[1m]';   " + M + "\n    const list = FALLBACK_MODELS[p] || FALLBACK_MODELS.openrouter;"
      },
      {
        what: 'claude-code needs no key',
        anchor: "    return p !== 'codex' && p !== 'grok' && p !== 'kimi' && p !== 'ollama' && p !== 'custom' && p !== 'starnet';",
        replaceWith: "    return p !== 'codex' && p !== 'grok' && p !== 'kimi' && p !== 'ollama' && p !== 'custom' && p !== 'starnet' && p !== 'claude-code';   " + M
      },
      {
        what: 'claude-code shows no key box',
        anchor: "    return p !== 'codex' && p !== 'grok' && p !== 'kimi' && p !== 'ollama' && p !== 'starnet';",
        replaceWith: "    return p !== 'codex' && p !== 'grok' && p !== 'kimi' && p !== 'ollama' && p !== 'starnet' && p !== 'claude-code';   " + M
      }
    ]
  },
  {
    file: 'frontend/app/harness.js',
    patches: [
      { what: 'teach normalizeProviderId about claude-code', anchor: NORM_ANCHOR, add: NORM_ADD },
      {
        /* THE THIRD COPY. app.js has two key predicates and harness.js has its own, and this
           one is the pre-flight guard that actually throws 'no API key set' on WAKE. Patching
           the app.js pair was not enough: the card rendered correctly, the catalog was right,
           and the awakening still died on a key that does not exist for this provider. */
        what: 'claude-code needs no key (harness pre-flight guard)',
        anchor: "    return p !== 'codex' && p !== 'grok' && p !== 'kimi' && p !== 'ollama' && p !== 'custom' && p !== 'starnet';",
        replaceWith: "    return p !== 'codex' && p !== 'grok' && p !== 'kimi' && p !== 'ollama' && p !== 'custom' && p !== 'starnet' && p !== 'claude-code';   " + M
      },
      {
        /* THE DESKTOP GAP. A packaged build answers "is this provider configured?" by
           enumerating the OS KEYCHAIN. Right question for a key, wrong one here: there is no
           key, the credential is a CLI login in ~/.claude, and without this the desktop build
           shows CLAUDE as unconfigured forever - exactly as codex/grok/kimi would without
           their own status probes. */
        what: 'desktop: learn claude-code state from the CLI probe',
        anchor: "        _configured = !!_configuredByProvider.openrouter;",
        replaceWith: "        _configured = !!_configuredByProvider.openrouter;\n"
                   + "        " + M + " try { const _lr = await fetch('/api/lovkar/status'); const _lj = await _lr.json(); _configuredByProvider['claude-code'] = !!(_lj && _lj.configured); } catch (_) {}"
      },
      {
        /* Same shape as codex/grok/kimi: the credential lives outside the browser (here, in
           ~/.claude), so selecting the provider IS the local truth. */
        what: 'claude-code counts as credentialed when selected',
        anchor: "    if (p === 'codex') return DESKTOP ? !!_configuredByProvider.codex : (getProv() === 'codex');",
        add: "\n    " + M + " if (p === 'claude-code') return DESKTOP ? !!_configuredByProvider['claude-code'] : (getProv() === 'claude-code');"
      }
    ]
  },
  {
    file: 'frontend/app/modeldock.js',
    patches: [
      { what: 'teach the dock normalizer about claude-code', anchor: NORM_ANCHOR, add: NORM_ADD }
    ]
  },
  {
    file: 'frontend/app/overseer-setup.js',
    patches: [
      {
        /* The generic copy tells the user to paste an API key. For this provider there is no
           key to paste: the credential is the CLI login already sitting in ~/.claude. */
        what: 'honest connect-card copy for claude-code',
        anchor: "      : ['grok','kimi','codex'].includes(provider) ? 'Sign in, then choose a model from your account.'",
        replaceWith: "      : provider === 'claude-code' ? 'Signed in through the Claude Code CLI on this computer - just choose a model.'   " + M + "\n"
                   + "      : ['grok','kimi','codex'].includes(provider) ? 'Sign in, then choose a model from your account.'"
      }
    ]
  },
  {
    file: 'src-tauri/tauri.conf.json',
    patches: [
      {
        /* THE TRAP. Left alone, a desktop build of this fork auto-updates from UPSTREAM's
           release feed - installMode "passive" on Windows, so it happens without a click and
           silently replaces the fork with stock StarNet. Point it at this fork's own repo:
           until a signed release exists there the updater simply finds nothing, which is the
           safe failure. Signing needs the fork's OWN minisign key; upstream's pubkey stays
           here on purpose, so an upstream artifact cannot verify either. */
        what: 'point the updater away from upstream releases',
        anchor: '        "https://github.com/androoAGI/starnet-releases/releases/latest/download/latest.json"',
        replaceWith: '        "https://github.com/Lovkar-Squid/starnet-lovkar/releases/latest/download/latest.json"'
      }
    ]
  },
  {
    file: 'frontend/index.html',
    patches: [
      {
        what: 'add the CLAUDE tile to Connect a brain',
        anchor: '                <button class="prov" data-prov="anthropic" aria-pressed="false">ANTHROPIC</button>',
        add: '\n                <!-- LOVKAR:claude-code - the whole point of this fork: Anthropic on a subscription.\n'
           + '                     Keyless like GROK/KIMI; the credential is the Claude Code CLI login in ~/.claude. -->\n'
           + '                <button class="prov" data-prov="claude-code" aria-pressed="false">CLAUDE <span class="prov-tag">SIGN IN</span></button>'
      }
    ]
  }
];

function backupPath(abs) { return abs + '.pre-lovkar'; }

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
    if (n !== 1) { console.error('  x anchor matched ' + n + ' times (need exactly 1): ' + p.what); problems++; continue; }
    console.log('  ' + (p.replaceWith ? '~' : '+') + ' ' + p.what);
    src = p.replaceWith ? src.replace(p.anchor, p.replaceWith) : src.replace(p.anchor, p.anchor + p.add);
  }
  staged.push({ abs, src, rel: f.file, pristine });
}

if (problems) { console.error('\n' + problems + ' anchor problem(s) - upstream moved. Nothing written.'); process.exit(1); }
if (mode === 'check') { console.log('\n--check: every anchor present and unique, nothing written'); process.exit(0); }

for (const s of staged) {
  if (!fs.existsSync(backupPath(s.abs))) fs.writeFileSync(backupPath(s.abs), s.pristine);
  fs.writeFileSync(s.abs, s.src);
}

let bad = 0;
for (const s of staged) {
  if (!/\.(js|mjs|cjs)$/.test(s.abs)) continue;   // html has no node syntax check
  try { execFileSync(process.execPath, ['--check', s.abs], { stdio: 'pipe' }); }
  catch (e) {
    bad++;
    fs.writeFileSync(s.abs, s.pristine);
    console.error('\nx syntax check failed for ' + s.rel + ', reverted:\n' + String(e.stderr || e.message));
  }
}
if (bad) process.exit(1);

const total = FILES.reduce((n, f) => n + f.patches.length, 0);
console.log('\nOK - ' + total + ' insertions across ' + FILES.length + ' files, all syntax-clean');
