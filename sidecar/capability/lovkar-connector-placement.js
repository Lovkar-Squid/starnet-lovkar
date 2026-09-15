/* sidecar/capability/lovkar-connector-placement.js — the connector portals on ONE agent's floor.

   savedPlacement() next door answers a different question, and deliberately: it reduces the floor
   to a deduplicated set of bare capability TYPES, and it drops `computer` and `connector` on the
   way out —

     .filter(t => t && t !== 'computer' && t !== 'connector')
     .map(objectType => ({ objectType }))

   — because on the native path those two are resolved elsewhere, per instance. That is correct
   for what it does, and it is also why a claude-code run could not see a single connector: by the
   time the placement reached the runner there was no connectorId left in it, and the connector
   manager's own connectorIdOf() needs one (it wants { objectType: 'connector', connectorId }).

   So this asks the same floor the same way and keeps what the other one throws away. It does NOT
   change savedPlacement: the native path's contract stays exactly as upstream wrote it.

     connectorPlacement(save, agentId) -> [{ objectType: 'connector', connectorId }]

   The scope rule is agentRoomId's, unchanged (see vault/notes/station-layout.md): an agent with a
   bay gets the room of its own desk, falling back to the bay's room; an agent with NO bay has no
   capability room at all and sees the station-wide floor, which is the pre-bay behaviour every
   other capability already falls back to. Deduplicated by connectorId, because two portals to the
   same server are one grant, not two. */

'use strict';

const { makeStationStore } = require('../station-store.js');

function connectorPlacement(save, agentId) {
  if (!save || !save.station) return [];
  let station;
  try {
    const checked = makeStationStore().validateStationDoc(save.station);
    if (!checked.ok) return [];
    station = checked.station;
  } catch (_) { return []; }

  const ids = [];
  const seen = Object.create(null);
  const take = (id) => {
    const s = String(id || '').trim();
    if (!s || seen[s]) return;
    seen[s] = true;
    ids.push(s);
  };

  let scoped = false;
  try { scoped = !!station.agentRoomId(String(agentId || 'agent')); } catch (_) { scoped = false; }

  if (scoped) {
    // The agent has a capability room: take the connector objects the station itself projects
    // into it, whatever shape they arrive in.
    let objs = [];
    try { objs = station.bayObjects(String(agentId || 'agent')) || []; } catch (_) { objs = []; }
    for (const o of objs) {
      if (!o || typeof o === 'string') continue;
      if (o.objectType !== 'connector') continue;
      take(o.connectorId || (o.binding && o.binding.connectorId));
    }
    if (ids.length) return ids.map((connectorId) => ({ objectType: 'connector', connectorId }));
    // bayObjects may hand back cap NAMES rather than instances depending on the projection; fall
    // through to reading the room's own props so a real portal is never missed on a shape detail.
  }

  /* Station-wide (no bay), or a scoped room whose projection carried no instances: read the props
     directly. When the agent HAS a room, only that room's portals count — the moat must not widen
     just because the projection came back thin. */
  let props = [];
  try { props = station.props() || []; } catch (_) { props = []; }

  let roomId = null;
  if (scoped) { try { roomId = station.agentRoomId(String(agentId || 'agent')); } catch (_) { roomId = null; } }

  for (const p of props) {
    if (!p || p.t !== 'connector_portal') continue;
    if (roomId) {
      let where = null;
      try { where = station.roomAt ? station.roomAt(p.x, p.y) : null; } catch (_) { where = null; }
      const whereId = where && (where.id || where);
      if (whereId && String(whereId) !== String(roomId)) continue;
      if (!whereId) continue;   // cannot place it in a room: do not grant it
    }
    take(p.connectorId || (p.binding && p.binding.connectorId));
  }

  return ids.map((connectorId) => ({ objectType: 'connector', connectorId }));
}

module.exports = { connectorPlacement };
