/* sidecar/apiauth.js — the PURE auth/guard logic for the loopback HTTP API, factored out of index.js so
   it is unit-testable (index.js self-boots a server and cannot be required by a test). index.js keeps the
   thin res-writing wrappers (applyApiCors / rejectApi / rejectBadApiToken) and delegates the decisions here.

   THREAT MODEL (read before changing):
   - PRIMARY (defended): a malicious WEBSITE the user visits must not drive the agent or read its data via
     fetch()/EventSource to the loopback port. Three layers stop it: (a) the Host pin defeats DNS-rebinding;
     (b) the Origin allow-list rejects foreign origins; (c) a per-launch secret token is REQUIRED on every
     API call — normally as a custom header, with documented query-token escape hatches for browser APIs that
     cannot set headers. A custom header cannot be set cross-origin without a CORS preflight the server refuses,
     and cross-origin reads of our page/responses are opaque, so a site can neither forge nor steal it.
   - RESIDUAL (accepted, documented): a process running as the SAME OS user can read the token (it is injected
     into the served page), the keychain, and the data files. That is inherent to a single-user loopback app —
     an OS-trust problem, not an app-layer one. We raise the bar (no free token vending; token on every route)
     but make no claim to stop same-user malware.

   All functions are pure (no ambient clock/rng). timingSafeEqual is deterministic, so this passes lint-determinism. */
'use strict';
const nodeCrypto = require('node:crypto');

// the desktop (Tauri) build serves the bundled UI from a custom-scheme origin, not the loopback http origin.
const TAURI_ORIGINS = new Set(['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost', 'app://localhost']);
function loopbackOrigins(port) { return new Set(['http://127.0.0.1:' + port, 'http://localhost:' + port]); }

// Is this Origin one of ours? Absent Origin is allowed HERE because same-origin GETs and non-browser clients
// omit it — but those callers are still gated by requiresApiToken (the token, not the origin, is their fence).
function isAllowedApiOrigin(origin, port) {
  if (!origin) return true;
  if (origin === 'null') return false;                 // file:/sandboxed origins are never the app
  return loopbackOrigins(port).has(origin) || TAURI_ORIGINS.has(origin);
}
// Host must be loopback — this is the DNS-rebinding defense (a rebinding attacker's forged Host fails here).
function isAllowedHost(host) {
  let h = String(host || '').toLowerCase().trim();
  const br = h.match(/^\[([^\]]+)\](?::\d+)?$/);                              // [ipv6] or [ipv6]:port
  if (br) h = br[1];
  else if ((h.match(/:/g) || []).length === 1) h = h.replace(/:\d+$/, '');   // host:port (single colon = ipv4/name)
  return h === '127.0.0.1' || h === 'localhost' || h === '::1';
}

// the path portion of a request url, query stripped (so '/api/x?y=z' matches '/api/x').
function pathOf(url) { const u = String(url || ''); const i = u.indexOf('?'); return i < 0 ? u : u.slice(0, i); }

/* Does this request require the custom-header token? YES for every /api/* route — GET data routes included —
   EXCEPT a small set that provably cannot carry the header:
     /api/key              : guarded by its OWN per-launch IPC_TOKEN (the desktop key push)
     /api/channels/token   : guarded by its OWN per-launch IPC_TOKEN (the desktop channel-token push)
     /api/health           : liveness probe
     /api/spotify/callback : an OAuth redirect — a top-level browser navigation, no place to put a header
     /api/connectors/oauth/callback : same — the MCP-connector OAuth redirect; the CSRF `state` param (matched
                             against the in-memory pending map) is its fence, exactly like the Spotify callback
     /api/channels/events  : SSE — EventSource cannot set headers, so it carries a ?token= query instead,
                             validated by queryTokenOk in the handler
     /api/file query token : not exempt; index.js accepts ?token only for GET/HEAD /api/file because native
                             media/link loads cannot attach a custom header
     /api/save query token : not exempt; index.js accepts ?token only for POST /api/save because the unload
                             beacon (navigator.sendBeacon) cannot attach a custom header either — the last
                             debounced save must survive a window close (see queryTokenRoute) */
const TOKEN_EXEMPT = new Set(['/api/key', '/api/channels/token', '/api/health', '/api/spotify/callback', '/api/connectors/oauth/callback', '/api/channels/events', '/api/lovkar/mcp/tools', '/api/lovkar/mcp/call']);
function requiresApiToken(req) {
  if (!req || req.method === 'OPTIONS') return false;
  const p = pathOf(req.url);
  if (p.indexOf('/api/') !== 0 && p !== '/api') return false;   // static assets / non-api never need a token
  return !TOKEN_EXEMPT.has(p);
}

function headerToken(req) {
  const h = (req && req.headers) || {};
  return String(h['x-starnet-token'] || h['x-skynet-token'] || '');   // dual-accept the legacy header name
}
function queryToken(req) {
  const u = String((req && req.url) || ''); const i = u.indexOf('?');
  if (i < 0) return '';
  try { return String(new URLSearchParams(u.slice(i + 1)).get('token') || ''); } catch (_) { return ''; }
}
// constant-time compare; false on any length mismatch / empty (never throws).
function constTimeEq(a, b) {
  a = String(a == null ? '' : a); b = String(b == null ? '' : b);
  if (!a || !b || a.length !== b.length) return false;
  try { return nodeCrypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch (_) { return false; }
}
function apiTokenOk(req, token) { return constTimeEq(headerToken(req), token); }     // header path (fetch)
function queryTokenOk(req, token) { return constTimeEq(queryToken(req), token); }    // query path (EventSource/SSE)

/* The narrow method×path matrix allowed to authenticate via ?token= instead of the custom header — ONLY the
   browser surfaces that PROVABLY cannot set a header:
     GET/HEAD /api/file : native media/link loads (<img>, <video>, clicked links)
     POST     /api/save : the unload beacon (navigator.sendBeacon) — the last debounced save on window close
   Everything else keeps the header-only rule (a query token in a URL is loggable/copyable, so the escape
   hatch stays as small as possible). Pure predicate on (method, path) so it is unit-testable. */
function queryTokenRoute(req) {
  const m = req && req.method;
  const p = pathOf(req && req.url);
  if ((m === 'GET' || m === 'HEAD') && p === '/api/file') return true;
  if (m === 'POST' && p === '/api/save') return true;
  return false;
}

module.exports = {
  isAllowedApiOrigin, isAllowedHost, requiresApiToken, apiTokenOk, queryTokenOk, queryTokenRoute,
  headerToken, queryToken, constTimeEq, pathOf, loopbackOrigins, TAURI_ORIGINS, TOKEN_EXEMPT
};
