/* sidecar/routes/lovkar-mcp.js — the two loopback routes the per-run connector bridge talks to.

   GET  /api/lovkar/mcp/tools   -> { tools: [{ name, description, inputSchema }] }
   POST /api/lovkar/mcp/call    { name, arguments } -> { result } | { error }

   Both are authenticated by the run's GRANT (header x-lovkar-grant), not by the station API
   token. That is deliberate: the station token would let any holder reach every connector, and
   the whole point of the moat is that a run reaches exactly what stands on its own floor.

   THE FLOOR IS RE-READ ON EVERY CALL. The grant stores the objects that were in the agent's room
   when the run started, and each call re-runs connectors.toolDefsForObjects over them. So if the
   Commander picks a portal up mid-run, the next call stops working — the floor stays the
   authority for the whole life of the run, not just its first instant.

   CONSENT, STATED HONESTLY. Upstream marks every connector tool requiresConsent: true and routes
   each first use through the consent broker, which asks the Commander. A Claude Code run has no
   broker attached (it short-circuits runOnce, which is where the broker is built). Rather than
   quietly call anyway — which would turn "ask" into "never asked" — a run whose agent is not at
   FULL POWER is refused here, with a message that says exactly that. NOVA runs at full power and
   is unaffected; an ASK agent gets an honest refusal instead of a silent escalation.

     makeLovkarMcp({ grants, connectors }) -> { handleTools, handleCall }

   The caller supplies the station's live connector manager and the shared grant store. */

'use strict';

const MAX_BODY = 1 << 20;   // 1 MiB: a connector call's arguments, not a file upload

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); try { req.destroy(); } catch (_) {} return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function makeLovkarMcp(deps) {
  const d = deps || {};
  const grants = d.grants;
  /* The connector manager arrives as a THUNK, not an object. index.js builds this route where
     chanEmit exists, several hundred lines before `const connectors = makeConnectorManager(...)`,
     so holding the value here would read a const in its temporal dead zone and throw at boot.
     A function is resolved on the first request, by which time the module has finished loading. */
  const connectorsOf = typeof d.connectors === 'function' ? d.connectors : () => d.connectors;
  if (!grants || typeof grants.lookup !== 'function') throw new Error('makeLovkarMcp: a grant store is required');

  const send = (res, code, obj) => {
    res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(obj));
  };

  const grantOf = (req) => {
    const id = String((req.headers && req.headers['x-lovkar-grant']) || '').trim();
    return id ? grants.lookup(id) : null;
  };

  /* The live defs for this grant's floor, keyed by the station's own wire name. Re-derived per
     request on purpose (see the header): the floor can move under a long run. */
  function liveDefs(grant) {
    let connectors = null;
    try { connectors = connectorsOf(); } catch (_) { connectors = null; }
    if (!connectors || typeof connectors.toolDefsForObjects !== 'function') return Object.create(null);
    let defs = [];
    try { defs = connectors.toolDefsForObjects(grant.objects || []) || []; } catch (_) { defs = []; }
    const byName = Object.create(null);
    for (const def of defs) if (def && def.name) byName[String(def.name)] = def;
    return byName;
  }

  /* The crew tools this run was given. Unlike a connector these cannot be re-derived here: they are
     host objects built inside the lead's own runOnce, closing over its run host and its signal. They
     live on the grant, which is in memory and revoked when the run ends. */
  function crewByPublishedName(grant) {
    const out = Object.create(null);
    for (const d of (grant.crewDefs || [])) if (d && d.publishedName && d.tool) out[d.publishedName] = d.tool;
    return out;
  }

  function handleTools(req, res) {
    const grant = grantOf(req);
    if (!grant) return send(res, 404, { error: 'no live grant' });
    const live = liveDefs(grant);
    // Publish only what the grant named AND the floor still carries. A portal picked up mid-run
    // disappears from the list rather than lingering as a tool that will refuse.
    const crew = crewByPublishedName(grant);
    const tools = [];
    for (const t of (grant.published || [])) {
      if (crew[t.name]) { tools.push(t); continue; }   // a crew tool belongs to the run, not to a prop
      const defName = grant.allow[t.name];
      if (defName && live[defName]) tools.push(t);
    }
    return send(res, 200, { tools: tools });
  }

  async function handleCall(req, res) {
    const grant = grantOf(req);
    if (!grant) return send(res, 404, { error: 'no live grant' });

    let body;
    try { body = JSON.parse(await readBody(req, MAX_BODY)) || {}; }
    catch (e) { return send(res, 400, { error: 'bad json' }); }

    const name = String(body.name || '');
    const defName = grant.allow[name];
    if (!defName) return send(res, 403, { error: 'the floor did not grant "' + name + '" to this run' });

    /* CREW FIRST. Delegation is granted by the orchestrator object at run start and carried on the
       grant, so there is no live floor to re-read for it — the grant IS the authority, and it dies
       with the run. Consent follows the connector rule: an ASK run is refused rather than quietly
       dispatching work in the Commander's name. */
    const crewTool = crewByPublishedName(grant)[name];
    if (crewTool) {
      if (!grant.fullPower) {
        return send(res, 403, {
          error: 'this run is in ASK mode and a Claude Code run has no consent prompt wired yet, so "'
               + name + '" is refused rather than dispatched without asking. Set the agent to FULL POWER '
               + 'if you mean it to delegate unattended.',
        });
      }
      try {
        const out = await crewTool.run(body.arguments || {}, { runId: grant.runId, agentId: grant.agentId, emit: null });
        const text = (out && typeof out === 'object' && typeof out.content === 'string') ? out.content
          : (typeof out === 'string' ? out : JSON.stringify(out == null ? {} : out));
        return send(res, 200, { result: { content: [{ type: 'text', text: String(text) }] } });
      } catch (e) {
        return send(res, 200, { error: (e && e.message) ? String(e.message) : String(e) });
      }
    }

    const live = liveDefs(grant);
    const def = live[defName];
    if (!def || typeof def.run !== 'function') {
      return send(res, 403, { error: 'the connector behind "' + name + '" is no longer on this agent\'s floor' });
    }

    /* Consent. Upstream gates every connector tool on the Commander's approval; this run has no
       broker to ask. Say so instead of proceeding — an ASK agent must not silently become a
       full-power one because it happens to be running through Claude Code. */
    if (!grant.fullPower) {
      return send(res, 403, {
        error: 'this run is in ASK mode and a Claude Code run has no consent prompt wired yet, '
             + 'so "' + name + '" is refused rather than called without asking. Set the agent to '
             + 'FULL POWER if you mean it to use connectors unattended.',
      });
    }

    try {
      const out = await def.run(body.arguments || {}, { runId: grant.runId, agentId: grant.agentId, emit: null });
      return send(res, 200, { result: out == null ? {} : out });
    } catch (e) {
      return send(res, 200, { error: (e && e.message) ? String(e.message) : String(e) });
    }
  }

  return { handleTools, handleCall };
}

module.exports = { makeLovkarMcp };
