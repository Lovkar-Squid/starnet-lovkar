/* sidecar/routes/lovkar-status.js — GET /api/lovkar/status

   Is the Claude Code CLI actually here, and is it actually logged in?

   This exists because the packaged desktop build answers "is this provider configured?" by
   enumerating the OS KEYCHAIN (`harness_provider_key_status`). That is the right question
   for every provider whose credential is a key, and the wrong one for this fork: there is no
   key, and the credential is a CLI login sitting in ~/.claude. Without a separate probe the
   desktop build would show CLAUDE as unconfigured forever, exactly as codex/grok/kimi would
   without theirs.

   Truthful telemetry, in the house style: every field is something observed on disk or
   printed by the binary. Nothing is inferred, and a missing answer is reported as unknown
   rather than guessed.

     makeLovkarStatus({ claudePath?, execFile? }) -> { handle(req, res), probe() }

   The response never contains the credential itself - only whether a credential file exists,
   its size and mtime. Those three are enough for a badge and give nothing away.
*/
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const VERSION_TIMEOUT_MS = 8000;

function resolveClaudePath(explicit) {
  if (explicit) return explicit;
  if (process.env.LOVKAR_CLAUDE_PATH) return process.env.LOVKAR_CLAUDE_PATH;
  const home = os.homedir();
  for (const g of [path.join(home, '.local', 'bin', 'claude.exe'), path.join(home, '.local', 'bin', 'claude')]) {
    try { if (fs.existsSync(g)) return g; } catch (_) {}
  }
  return 'claude';
}

function makeLovkarStatus(deps) {
  deps = deps || {};
  const claudePath = resolveClaudePath(deps.claudePath);
  const run = deps.execFile || execFile;

  function credentialState() {
    // Claude Code stores the login here on Windows and Linux; on macOS it prefers the
    // Keychain and falls back to this file. An absent file on macOS is therefore NOT proof
    // of being logged out, and this says so rather than claiming a logout it cannot see.
    const home = os.homedir();
    const dir = process.env.CLAUDE_CONFIG_DIR || path.join(home, '.claude');
    const file = path.join(dir, '.credentials.json');
    try {
      const st = fs.statSync(file);
      return { loggedIn: true, credentialFile: file, bytes: st.size, updatedAt: new Date(st.mtimeMs).toISOString() };
    } catch (_) {
      const macKeychain = process.platform === 'darwin';
      return {
        loggedIn: macKeychain ? null : false,
        credentialFile: file,
        note: macKeychain
          ? 'no credentials file; on macOS the login may live in the Keychain instead, which this cannot read'
          : 'no credentials file - run `claude` once and complete the browser login'
      };
    }
  }

  function version() {
    return new Promise(resolve => {
      let done = false;
      const t = setTimeout(() => { if (!done) { done = true; resolve(null); } }, VERSION_TIMEOUT_MS);
      try {
        run(claudePath, ['--version'], { timeout: VERSION_TIMEOUT_MS, windowsHide: true }, (err, stdout) => {
          if (done) return;
          done = true; clearTimeout(t);
          resolve(err ? null : String(stdout || '').trim());
        });
      } catch (_) { if (!done) { done = true; clearTimeout(t); resolve(null); } }
    });
  }

  async function probe() {
    const v = await version();
    const cred = credentialState();
    const installed = !!v;
    return {
      provider: 'claude-code',
      installed,
      binary: claudePath,
      version: v || null,
      // `configured` is what the UI badge keys on. Deliberately conservative: an unreadable
      // macOS Keychain reports loggedIn:null, and null is not true.
      configured: installed && cred.loggedIn === true,
      login: cred,
      platform: process.platform
    };
  }

  async function handle(req, res) {
    let body;
    try { body = await probe(); }
    catch (e) { body = { provider: 'claude-code', installed: false, configured: false, error: (e && e.message) || 'probe failed' }; }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  }

  return { handle, probe, claudePath };
}

module.exports = { makeLovkarStatus, resolveClaudePath };
