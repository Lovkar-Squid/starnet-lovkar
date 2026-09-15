#!/usr/bin/env node
/*
  audit-floor.js — what does each agent ACTUALLY get from the floor?

  The station save is the only source of truth about capabilities, and it moves every time the
  Commander drags a prop. This re-derives, from the save on disk, the same answer the sidecar
  computes at run time: for every agent, its capability room and the caps that room grants it.

  The two rules it applies are READ OUT OF frontend/app/worldmodel.js, not copied here, so this
  script cannot drift away from the code it is auditing:

    SEAT_WORKSTATIONS  which prop types count as "a desk of one's own"
    CAP_PROP_MAP       prop type -> capability

  agentRoomId (worldmodel.js): an agent with NO bay has no capability room at all and falls back
  to the legacy station-wide scope. An agent WITH a bay gets the room of its own first desk, and
  the bay's room only when it has no desk anywhere. Bays are remote work triggers, not grants.

  COMPUTE is per-agent: a workstation BOUND to the agent, or (back-compat) an unbound one when a
  single agent resolves into that room. Every other cap is shared by everyone in the room.

  Usage:  node lovkar/audit-floor.js [--save <path>] [--json]
*/

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// ---------------------------------------------------------------- locate inputs

function defaultSavePath() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'ai.skynet.harness', 'workspaces', 'agent.save.json');
}

function worldModelPath() {
  return path.join(__dirname, '..', 'frontend', 'app', 'worldmodel.js');
}

// ------------------------------------------------- read the rules out of the code

/* Pull one `const NAME = { ... };` object literal out of the source and evaluate it. Keys in
   worldmodel.js are unquoted, so this is not JSON; a Function over our own repo file is the
   honest way to read it. Brace-matching (not a lazy regex) so a nested literal cannot truncate. */
function readObjectLiteral(src, name) {
  const decl = new RegExp('\\b' + name + '\\s*=\\s*\\{');
  const m = decl.exec(src);
  if (!m) return null;
  const open = m.index + m[0].length - 1;
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const body = src.slice(open, i + 1);
        try {
          // eslint-disable-next-line no-new-func
          return new Function('return (' + body + ')')();
        } catch (_) { return null; }
      }
    }
  }
  return null;
}

const FALLBACK_SEATS = { desk: 1, desk2: 1, console: 1, consoleL: 1, pixelrig: 1, bench: 1 };

function loadRules() {
  let src = '';
  try { src = fs.readFileSync(worldModelPath(), 'utf8'); } catch (_) { /* below */ }
  const seats = readObjectLiteral(src, 'SEAT_WORKSTATIONS');
  const caps = readObjectLiteral(src, 'CAP_PROP_MAP');
  const warn = [];
  if (!seats) warn.push('SEAT_WORKSTATIONS could not be read from worldmodel.js — using a built-in copy');
  if (!caps) warn.push('CAP_PROP_MAP could not be read from worldmodel.js — compute-only audit');
  return { seats: seats || FALLBACK_SEATS, caps: caps || {}, warn };
}

// ---------------------------------------------------------------- the floor

function loadStation(savePath) {
  const raw = JSON.parse(fs.readFileSync(savePath, 'utf8'));
  const doc = raw.doc || raw;
  const station = doc.station;
  if (!station || !station.props) throw new Error('no doc.station.props in ' + savePath);
  const agents = [];
  const seen = new Set();
  for (const a of [doc.agent].concat(doc.agents || [])) {
    if (!a || !a.id || seen.has(a.id)) continue;
    seen.add(a.id);
    agents.push(a);
  }
  return { station, agents, savedAt: raw.savedAt || doc.updatedAt || null };
}

function makeFloor(station, rules) {
  const rooms = Object.values(station.rooms || {});
  const props = station.props || [];

  const roomAt = (x, y) => {
    for (const r of rooms) {
      for (const q of r.rects || []) {
        if (x >= q.x1 && x <= q.x2 && y >= q.y1 && y <= q.y2) return r;
      }
    }
    return null;
  };
  const roomOfProp = (p) => roomAt(p.x, p.y);

  const bayOf = (id) => props.find((p) => p.t === 'bay' && p.agentId === id) || null;
  const desksOf = (id) => props.filter((p) => rules.seats[p.t] && p.agentId === id);

  // worldmodel.js agentRoomId, byte for byte
  const agentRoom = (id) => {
    const bay = bayOf(id);
    if (!bay) return null;
    const desk = props.find((p) => rules.seats[p.t] && p.agentId === id);
    if (desk) { const r = roomAt(desk.x, desk.y); if (r) return r; }
    return roomAt(bay.x, bay.y);
  };

  const occupantsOf = (room) => props
    .filter((p) => p.t === 'bay' && p.agentId)
    .map((p) => p.agentId)
    .filter((id, i, a) => a.indexOf(id) === i)
    .filter((id) => { const r = agentRoom(id); return r && r.id === room.id; });

  const capsFor = (id, room) => {
    const out = {};
    const solo = occupantsOf(room).length === 1;
    for (const p of props) {
      const r = roomOfProp(p);
      if (!r || r.id !== room.id) continue;
      const cap = rules.caps[p.t];
      if (!cap) continue;
      if (cap === 'computer') {
        const mine = p.agentId === id;
        const spare = !p.agentId && solo;
        if (!mine && !spare) continue;
        (out.computer = out.computer || []).push(p.id + (mine ? ' (bound)' : ' (unbound, solo room)'));
      } else {
        (out[cap] = out[cap] || []).push(p.id + ':' + p.t + (p.connectorId ? '=' + p.connectorId : ''));
      }
    }
    return out;
  };

  return { rooms, props, roomAt, roomOfProp, bayOf, desksOf, agentRoom, occupantsOf, capsFor };
}

function audit(savePath) {
  const rules = loadRules();
  const { station, agents, savedAt } = loadStation(savePath);
  const f = makeFloor(station, rules);

  const report = { savePath, savedAt, warnings: rules.warn.slice(), agents: [], rooms: [] };

  for (const r of f.rooms) {
    report.rooms.push({
      id: r.id,
      name: r.name || r.kind || r.id,
      kind: r.kind || null,
      occupants: f.occupantsOf(r),
      props: f.props.filter((p) => { const q = f.roomOfProp(p); return q && q.id === r.id; })
        .map((p) => ({ id: p.id, t: p.t, cap: rules.caps[p.t] || null, agentId: p.agentId || null })),
    });
  }

  for (const a of agents) {
    const bay = f.bayOf(a.id);
    const desks = f.desksOf(a.id);
    const room = f.agentRoom(a.id);
    const deskList = desks.map((d) => ({ id: d.id, t: d.t, room: (f.roomOfProp(d) || {}).name || '(outside any room)' }));
    const entry = {
      id: a.id,
      name: a.name || a.id,
      role: a.role || null,
      model: a.model || null,
      provider: a.provider || null,
      approvalMode: a.approvalMode || null,
      bay: bay ? { id: bay.id, role: bay.role || null, room: (f.roomOfProp(bay) || {}).name || null } : null,
      desks: deskList,
      room: room ? room.name || room.id : null,
      shareWith: room ? f.occupantsOf(room).filter((x) => x !== a.id) : [],
      caps: room ? f.capsFor(a.id, room) : null,
      problems: [],
    };

    if (!bay) {
      entry.problems.push('no bay — agentRoomId is null, so the floor grants it nothing; it runs on the legacy station-wide scope');
      if (deskList.length) entry.problems.push('its workstation ' + deskList.map((d) => d.id + '@' + d.room).join(', ') + ' is inert without a bay');
    } else {
      if (!entry.caps || !entry.caps.computer) entry.problems.push('NO COMPUTE — no workstation it may use in ' + entry.room);
      if (desks.length > 1) {
        entry.problems.push('has ' + deskList.length + ' workstations (' + deskList.map((d) => d.id + '@' + d.room).join(', ') +
          '); only the first in prop order counts, the rest are dead weight');
      }
      if (!desks.length) entry.problems.push('no workstation of its own — falls back to the bay room ' + entry.room +
        ', which breaks the moment a shared prop moves');
      if (entry.shareWith.length) {
        entry.problems.push('shares ' + entry.room + ' with ' + entry.shareWith.join(', ') +
          ' — files, web, memory, terminal and connectors there are common to all of them');
      }
    }
    report.agents.push(entry);
  }

  // rooms holding a bay but no workstation: fine today, a trap tomorrow
  for (const r of report.rooms) {
    const hasBay = r.props.some((p) => p.t === 'bay');
    const hasSeat = r.props.some((p) => rules.seats[p.t]);
    if (hasBay && !hasSeat) {
      report.warnings.push(r.name + ' holds bays but no workstation — every agent bayed there depends on a desk ' +
        'in another room, and goes NO COMPUTE the moment that desk is removed');
    }
  }

  return report;
}

// ---------------------------------------------------------------- output

function pad(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); }

function print(rep) {
  console.log('FLOOR AUDIT  ' + rep.savePath);
  if (rep.savedAt) console.log('saved        ' + new Date(rep.savedAt).toISOString());
  console.log('');

  for (const a of rep.agents) {
    console.log(pad(a.name, 16) + (a.provider || '?') + ' / ' + (a.model || '?') +
      '   approval=' + (a.approvalMode || '?'));
    console.log('  bay    ' + (a.bay ? a.bay.id + ' ' + (a.bay.role || '') + ' @' + a.bay.room : '—'));
    console.log('  desk   ' + (a.desks.length ? a.desks.map((d) => d.id + '(' + d.t + ')@' + d.room).join(', ') : '—'));
    console.log('  ROOM   ' + (a.room || 'none (legacy station-wide scope)'));
    if (a.caps) {
      const keys = Object.keys(a.caps);
      console.log('  caps   ' + (keys.length ? keys.map((k) => k + '[' + a.caps[k].join(' ') + ']').join('\n         ') : 'NONE'));
    }
    for (const p of a.problems) console.log('  !!     ' + p);
    console.log('');
  }

  if (rep.warnings.length) {
    console.log('WARNINGS');
    for (const w of rep.warnings) console.log('  !! ' + w);
    console.log('');
  }

  const bad = rep.agents.filter((a) => a.problems.length).length;
  console.log(bad ? bad + ' of ' + rep.agents.length + ' agents have something worth looking at.'
    : 'Every agent has a room, compute, and no sharing surprises.');
}

function main() {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--save');
  const savePath = i >= 0 && argv[i + 1] ? argv[i + 1] : defaultSavePath();
  let rep;
  try {
    rep = audit(savePath);
  } catch (e) {
    console.error('audit-floor: ' + e.message);
    process.exit(2);
  }
  if (argv.includes('--json')) console.log(JSON.stringify(rep, null, 2));
  else print(rep);
}

if (require.main === module) main();

module.exports = { audit, loadRules, makeFloor, defaultSavePath };
