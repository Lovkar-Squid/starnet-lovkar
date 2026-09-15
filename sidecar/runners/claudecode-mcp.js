/* sidecar/runners/claudecode-mcp.js — the floor, projected onto MCP.

   claudecode-caps.js projects placed objects onto Claude Code's BUILT-IN tools (--tools +
   --restricted). This does the same job for connectors, and it has to be a separate projection
   because MCP is gated differently. Measured 2026-09-15 (lovkar/probe-mcp-stdio.js, 7/7):

     --tools does NOT gate MCP tools.        Every tool a declared server publishes is visible
                                             whatever --tools says. The built-in gate does not
                                             reach here at all.
     --mcp-config IS the gate for SERVERS.   A server that is not declared does not exist.
     --allowedTools IS the gate for TOOLS.   Under --permission-mode dontAsk an MCP call is
                                             refused unless pre-approved by its exact
                                             mcp__<server>__<tool> name, and a sibling tool of
                                             the same server stays refused.

   WHICH CONNECTORS A RUN GETS IS NOT DECIDED HERE. The station already answers that question:
   connectors.toolDefsForObjects(objects) is upstream's own per-agent projection — the tool defs
   for every connector portal standing in that agent's room, deduplicated. Re-deriving it would
   mean this fork could quietly disagree with upstream about what a placed portal grants, which
   is the one thing the moat cannot afford. So the caller hands the defs in and this file only
   decides how they reach the CLI.

   NO TOKEN LEAVES THE SIDECAR. The rejected route (lovkar/probe-mcp-config.js) was to write the
   Commander's live OAuth token into a per-run config file; it dies an hour later mid-run anyway.
   Here the per-run file carries a loopback URL and a grant id, the bridge is a local process, and
   the sidecar's connector manager keeps the token, refreshes it on a 401 and rotates it itself.

     resolveClaudeMcp({ defs, nodePath, bridgePath, url, grantId }) -> {
       servers,       // the mcpServers object for --mcp-config, or null when the floor grants none
       allowedTools,  // the mcp__lovkar__<name> names to pre-approve
       grant,         // published name -> the station's own def name, the sidecar's allow-list
       published,     // [{ name, description, inputSchema }] — what the bridge will publish
       summary        // one line for the run log
     }

   Pure: no fs, no spawn, no clock. */

'use strict';

const SERVER = 'lovkar';

// A published name has to survive being pasted into --allowedTools and matched back out of a
// tools/call, so anything outside this grammar is dropped rather than mangled. The station's own
// wire names are already mcp__<connectorId>__<tool>; the leading mcp__ is stripped so the name the
// model sees is mcp__lovkar__<connectorId>__<tool> rather than a doubled prefix.
const SAFE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,120}$/;

function publishedNameOf(defName) {
  const s = String(defName || '');
  return s.startsWith('mcp__') ? s.slice(5) : s;
}

function fullName(published) { return 'mcp__' + SERVER + '__' + published; }

function resolveClaudeMcp(opts) {
  const o = opts || {};
  const defs = Array.isArray(o.defs) ? o.defs : [];

  const grant = Object.create(null);    // published name -> the station def name
  const published = [];
  const allowedTools = [];
  const dropped = [];

  for (const d of defs) {
    if (!d || !d.name) continue;
    const pub = publishedNameOf(d.name);
    if (!SAFE.test(pub)) { dropped.push(String(d.name)); continue; }
    if (grant[pub]) continue;           // upstream already deduped by wire name; belt and braces
    grant[pub] = String(d.name);
    published.push({
      name: pub,
      description: String(d.description || ''),
      // The station stores the translated JSON Schema on `schema`; MCP calls it inputSchema.
      inputSchema: (d.schema && typeof d.schema === 'object') ? d.schema : { type: 'object', properties: {} },
    });
    allowedTools.push(fullName(pub));
  }

  const names = Object.keys(grant);
  /* `force` declares the bridge even with no connector tool on it. The crew tools ride the same
     server (see claudecode-crew.js), so a floor with an orchestrator but no portal still needs the
     process spawned — without this the run would be granted delegation and handed no way to call it. */
  const servers = (names.length || o.force) && o.bridgePath && o.url && o.grantId
    ? {
      [SERVER]: {
        command: String(o.nodePath || process.execPath),
        args: [String(o.bridgePath)],
        // The grant id and the loopback URL travel in the child's ENVIRONMENT, never in argv:
        // a Windows process command line is readable by every other process on the machine.
        env: Object.assign({
          LOVKAR_MCP_URL: String(o.url),
          LOVKAR_MCP_GRANT: String(o.grantId),
        },
        o.logFile ? { LOVKAR_MCP_LOG: String(o.logFile) } : {},
        // a delegated worker runs for minutes; the bridge must not be the narrowest cap
        o.callTimeoutMs ? { LOVKAR_MCP_CALL_TIMEOUT_MS: String(o.callTimeoutMs) } : {}),
      },
    }
    : null;

  // Group by connector for a log line a human can read at a glance.
  const byConnector = Object.create(null);
  for (const pub of names) {
    const cid = pub.indexOf('__') > 0 ? pub.slice(0, pub.indexOf('__')) : pub;
    byConnector[cid] = (byConnector[cid] || 0) + 1;
  }
  const cids = Object.keys(byConnector);
  const bits = [cids.length
    ? 'connectors: ' + cids.map((c) => c + '(' + byConnector[c] + ')').join(', ')
    : 'connectors: none'];
  if (dropped.length) bits.push('dropped (unusable name): ' + dropped.slice(0, 5).join(', '));

  return {
    servers: servers,
    allowedTools: allowedTools,
    grant: grant,
    published: published,
    dropped: dropped,
    summary: bits.join(' | '),
  };
}

module.exports = { resolveClaudeMcp, publishedNameOf, fullName, SERVER, SAFE };
