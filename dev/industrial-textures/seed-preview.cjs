'use strict';
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const wm = require(path.join(root, 'frontend/app/worldmodel.js'));
const scratch = path.join(root, 'dev/.scratch-workspace');
const target = path.join(scratch, 'agent.save.json');
if (fs.existsSync(target)) { console.log('Existing preview kept.'); process.exit(0); }
fs.cpSync(path.join(root, 'dev/fixtures/seed-workspace'), scratch, { recursive: true });
const save = JSON.parse(fs.readFileSync(target, 'utf8'));
const station = wm.defaultDoc();
station.rooms.r1.name = 'COMMAND DECK';
station.rooms.r1.rects = [{ x1: 0, y1: 0, x2: 21, y2: 17 }];
station.props = [
  { id: 'p1', t: 'desk', x: 10, y: 2, w: 2, h: 1, block: true, agentId: 'agent' },
  { id: 'p2', t: 'desk2', x: 4, y: 2, w: 2, h: 1, block: true },
  { id: 'p3', t: 'desk2', x: 16, y: 2, w: 2, h: 1, block: true }
];
station._nid = 10;
save.doc.station = station;
save.updatedAt = save.savedAt = save.doc.updatedAt = Date.now();
fs.writeFileSync(target, JSON.stringify(save, null, 2));
console.log('Bare station prepared with three workstations.');
