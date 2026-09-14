/* sidecar/vault/vault-md.js — PURE markdown-note <-> record conversion.

   One memory = one .md file with YAML front matter and a body. Plain files on purpose:
   you can open the vault in Obsidian (or any editor), read what your agents believe, fix a
   wrong line by hand, and `git log` how a belief changed. Nothing here touches disk.

     parse(text) -> { meta, body }
     serialize({ meta, body }) -> text
     summarize(body, n) -> one-line preview

   The front matter is deliberately a FLAT scalar/array map — no nested YAML — so the parser
   stays dependency-free and a hand-edit can never produce something we fail to read back.
*/
'use strict';

const FM = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function parseScalar(v) {
  v = v.trim();
  if (!v) return '';
  if (v[0] === '[' && v[v.length - 1] === ']') {
    return v.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
  }
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  if (v === 'true') return true;
  if (v === 'false') return false;
  return v.replace(/^["']|["']$/g, '');
}

function parse(text) {
  text = String(text == null ? '' : text);
  const m = text.match(FM);
  if (!m) return { meta: {}, body: text.trim() };
  const meta = {};
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    if (!k || k[0] === '#') continue;
    meta[k] = parseScalar(line.slice(i + 1));
  }
  return { meta, body: text.slice(m[0].length).trim() };
}

function dumpScalar(v) {
  if (Array.isArray(v)) return '[' + v.map(x => String(x)).join(', ') + ']';
  if (typeof v === 'string' && (v.indexOf(':') >= 0 || v.indexOf('#') >= 0)) return JSON.stringify(v);
  return String(v);
}

function serialize(rec) {
  rec = rec || {};
  const meta = rec.meta || {};
  const keys = Object.keys(meta).filter(k => meta[k] !== undefined && meta[k] !== null);
  const fm = keys.map(k => k + ': ' + dumpScalar(meta[k])).join('\n');
  return '---\n' + fm + '\n---\n\n' + String(rec.body == null ? '' : rec.body).trim() + '\n';
}

function summarize(body, n) {
  n = n || 120;
  const s = String(body == null ? '' : body)
    .replace(/\[\[([^\]]+)\]\]/g, '$1')
    .replace(/[#*`>]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
}

// A note id is a file name. Keep it boring so it is safe on every filesystem and pleasant
// to see in Obsidian's sidebar.
function slug(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'note';
}

module.exports = { parse, serialize, summarize, slug, FM };
