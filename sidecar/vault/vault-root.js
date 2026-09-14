/* sidecar/vault/vault-root.js — WHERE the vault lives, decided once for every sidecar copy.

   The bug this file exists to prevent, observed 2026-09-14: the vault root was
   `path.join(process.cwd(), 'vault')`. The dev sidecar runs from the repo, the packaged
   desktop build runs from `src-tauri/target/release`, so the two grew SEPARATE memories —
   notes written from the station were invisible to the desktop app and vice versa. A memory
   that silently forks is worse than no memory, because nothing looks broken.

     resolveVaultRoot({ cwd, env, fs, dirname }) -> absolute path

   Precedence, highest first:
     1. LOVKAR_VAULT_DIR          — an explicit choice always wins, and is how a real install
                                    outside a checkout pins the vault somewhere sensible.
     2. the fork checkout         — walk up from THIS FILE and from cwd looking for a directory
                                    holding both CLAUDE.md and lovkar/patch-upstream.js. The
                                    packaged build lives at <repo>/src-tauri/target/release/…,
                                    so the walk finds <repo> and both copies agree.
     3. <cwd>/vault               — the honest fallback when this is not a checkout at all.

   Deliberately NOT a symlink or a junction: magic on disk is invisible to whoever reads the
   code next, and a rebuild would quietly drop it.
*/
'use strict';

const REAL_FS = require('fs');
const path = require('path');

const MARKERS = ['CLAUDE.md', path.join('lovkar', 'patch-upstream.js')];
const MAX_UP = 8;

function isCheckout(dir, fs) {
  for (const m of MARKERS) { if (!fs.existsSync(path.join(dir, m))) return false; }
  return true;
}

function walkUp(start, fs) {
  let d = path.resolve(start);
  for (let i = 0; i < MAX_UP; i++) {
    if (isCheckout(d, fs)) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  return null;
}

function resolveVaultRoot(o) {
  o = o || {};
  const fs = o.fs || REAL_FS;
  const env = o.env || process.env;
  const cwd = o.cwd || process.cwd();
  const from = o.dirname || __dirname;

  const pinned = String(env.LOVKAR_VAULT_DIR || '').trim();
  if (pinned) return path.resolve(pinned);

  // __dirname first: the running code knows which checkout it was copied from, and cwd is
  // whatever the launcher happened to choose.
  const repo = walkUp(from, fs) || walkUp(cwd, fs);
  if (repo) return path.join(repo, 'vault');

  return path.join(path.resolve(cwd), 'vault');
}

module.exports = { resolveVaultRoot, isCheckout };
