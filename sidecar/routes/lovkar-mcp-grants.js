/* sidecar/routes/lovkar-mcp-grants.js — what ONE run is allowed to reach, held in memory only.

   THE POINT. The bridge process a run talks to is spawned BY the Claude Code CLI, which the agent
   drives. So the bridge is not a security boundary, and neither is --allowedTools: both are the
   CLI cooperating. The boundary is the sidecar, which refuses any connector call the run's own
   grant does not name — whatever the child process asks for.

   A grant is minted when a run starts, keyed by an unguessable id handed to the bridge in its
   environment, and revoked when the run ends. It never touches disk: a station restart must
   invalidate every grant, and a grant sitting in a file would outlive the run it belonged to.

     makeGrants({ clock, random, ttlMs }) -> {
       mint(runId, payload) -> grantId | null   // null when the payload grants nothing
       lookup(grantId)      -> payload | null   // { runId, ...caller's fields }
       revoke(grantId)      -> boolean
       revokeRun(runId)     -> number
       size()               -> number
     }

   The payload's shape belongs to the caller (see routes/lovkar-mcp.js): this module only owns
   the id, the lifetime and the refusal. Pure except for the injected clock and randomness. */

'use strict';

const DEFAULT_TTL_MS = 6 * 60 * 60 * 1000;   // a long agent run is hours; a leaked id must still die

function makeGrants(deps) {
  const d = deps || {};
  const clock = d.clock && typeof d.clock.now === 'function' ? d.clock : { now: () => Date.now() };
  const random = typeof d.random === 'function'
    ? d.random
    : () => require('crypto').randomBytes(32).toString('hex');
  const ttlMs = Number.isFinite(d.ttlMs) ? Number(d.ttlMs) : DEFAULT_TTL_MS;

  const grants = new Map();

  function sweep() {
    const now = clock.now();
    for (const [id, g] of grants) if (g.expiresAt <= now) grants.delete(id);
  }

  return {
    mint(runId, payload) {
      sweep();
      const p = payload && typeof payload === 'object' ? payload : null;
      // Nothing granted: mint nothing. An id that permits nothing is still an id to leak.
      if (!p || !p.allow || !Object.keys(p.allow).length) return null;
      const id = String(random());
      grants.set(id, Object.assign({}, p, { runId: String(runId || ''), expiresAt: clock.now() + ttlMs }));
      return id;
    },

    lookup(grantId) {
      sweep();
      const g = grants.get(String(grantId || ''));
      return g || null;
    },

    revoke(grantId) { return grants.delete(String(grantId || '')); },

    revokeRun(runId) {
      const want = String(runId || '');
      let n = 0;
      for (const [id, g] of grants) if (g.runId === want) { grants.delete(id); n++; }
      return n;
    },

    size() { sweep(); return grants.size; },
  };
}

// One per sidecar process, shared by the route and the runner — the same shape as
// ratelimit-gate.js's shared gate, and for the same reason: there is exactly one station here.
let shared = null;
function sharedGrants() { return (shared || (shared = makeGrants({}))); }

module.exports = { makeGrants, sharedGrants, DEFAULT_TTL_MS };
