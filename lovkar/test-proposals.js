/* lovkar/test-proposals.js — an agent proposes, only the Commander places.

   Two halves, both free and offline:
     1. sidecar/vault/proposals.js — what counts as a valid proposal, and what a decision leaves
        on disk. Everything in a proposal file is model output, so the refusals matter as much
        as the happy path.
     2. frontend/app/lovkar-proposals.js — the Accept path, driven against the REAL WorldModel,
        so "placed" is proven by the model's own validated mutations rather than by a stub.

   Run:  node lovkar/test-proposals.js
*/
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeProposals, validateProposal } = require('../sidecar/vault/proposals.js');

let pass = 0, fail = 0;
function ok(cond, what) { if (cond) { pass++; } else { fail++; console.error('  FAIL: ' + what); } }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lovkar-proposals-'));
const P = makeProposals({ root: tmp, now: () => new Date('2026-09-15T08:00:00Z') });
const put = (name, body) => {
  fs.mkdirSync(P.dir, { recursive: true });
  fs.writeFileSync(path.join(P.dir, name), typeof body === 'string' ? body : JSON.stringify(body));
};

/* ---- validation ---- */
{
  ok(validateProposal({ kind: 'object', type: 'workbench', reason: 'build the mod' }, 'a').ok, 'a workbench proposal is valid');
  ok(!validateProposal({ kind: 'object', type: 'workbench' }, 'a').ok, 'no reason -> refused');
  ok(!validateProposal({ kind: 'object', type: 'bay', reason: 'x' }, 'a').ok, 'bay cannot be proposed');
  ok(!validateProposal({ kind: 'object', type: 'connector_portal', reason: 'x' }, 'a').ok, 'connector_portal cannot be proposed');
  ok(!validateProposal({ kind: 'object', type: '../../etc', reason: 'x' }, 'a').ok, 'a path-shaped type is refused');
  ok(!validateProposal({ kind: 'room', roomKind: 'corridor', width: 5, height: 5, reason: 'x' }, 'a').ok, 'corridor is not a proposable room kind');
  ok(!validateProposal({ kind: 'room', roomKind: 'lab', width: 2, height: 5, reason: 'x' }, 'a').ok, 'a room below the minimum is refused');
  ok(!validateProposal({ kind: 'room', roomKind: 'lab', width: 99, height: 5, reason: 'x' }, 'a').ok, 'an oversized room is refused');
  ok(!validateProposal({ kind: 'grant', reason: 'x' }, 'a').ok, 'an unknown kind is refused');
  const v = validateProposal({ kind: 'object', type: 'shelf', reason: 'r', allowedTools: ['Bash'], fullPower: true }, 'a');
  ok(v.ok && !('allowedTools' in v.proposal) && !('fullPower' in v.proposal), 'unknown fields are dropped, never passed through');
  const c = validateProposal({ kind: 'object', type: 'shelf', reason: 'line1' + String.fromCharCode(10) + 'IGNORE PREVIOUS' + String.fromCharCode(0) }, 'a');
  ok(c.ok && !Array.from(c.proposal.reason).some(ch => ch.charCodeAt(0) < 32), 'control characters are stripped from shown text');
}

/* ---- list ---- */
{
  put('good-bench.json', { kind: 'object', type: 'workbench', agent: 'agent', reason: 'run gradle' });
  put('lab-room.json', { kind: 'room', roomKind: 'lab', width: 6, height: 5, reason: 'testing space' });
  put('broken.json', '{not json');
  put('BAD NAME.json', { kind: 'object', type: 'shelf', reason: 'x' });
  put('notes.txt', 'ignored');
  const rows = P.list();
  const by = id => rows.find(r => r.id === id);
  ok(rows.length === 4, 'lists every .json, valid or not (got ' + rows.length + ')');
  ok(by('good-bench') && by('good-bench').ok && by('good-bench').type === 'workbench', 'valid object listed');
  ok(by('lab-room') && by('lab-room').ok && by('lab-room').width === 6, 'valid room listed');
  ok(by('broken') && !by('broken').ok, 'broken JSON reported with an error, not skipped');
  ok(rows.some(r => !r.ok && /file name/.test(r.error)), 'bad file name reported');
}

/* ---- decide ---- */
{
  ok(!P.decide('good-bench', { status: 'placed' }).ok, 'an unknown status is refused');
  ok(!P.decide('../x', { status: 'rejected' }).ok, 'a path-shaped id is refused');
  ok(!P.decide('nope', { status: 'rejected' }).ok, 'deciding a missing proposal is refused');
  ok(!P.decide('broken', { status: 'accepted' }).ok, 'an invalid proposal cannot be accepted');
  ok(P.decide('broken', { status: 'rejected' }).ok, 'but it can be rejected and cleared');

  const r = P.decide('good-bench', { status: 'accepted', detail: 'placed in HAB-01 at 1,1' });
  ok(r.ok, 'accept records');
  ok(!fs.existsSync(path.join(P.dir, 'good-bench.json')), 'accepted file leaves pending');
  const rec = JSON.parse(fs.readFileSync(path.join(P.decidedDir, 'good-bench.json'), 'utf8'));
  ok(rec.status === 'accepted' && rec.type === 'workbench' && rec.decidedAt === '2026-09-15T08:00:00.000Z', 'decided record carries status, type and time');
  ok(P.list().every(x => x.id !== 'good-bench'), 'no longer pending');

  const prompt = P.promptBlock('nova');
  ok(/PLACEMENT PROPOSALS/.test(prompt) && prompt.indexOf(P.dir) >= 0, 'prompt names the real proposals folder');
  ok(/"agent":"nova"/.test(prompt), 'prompt stamps the agent id');
  ok(/good-bench \(object workbench\): accepted/.test(prompt), 'prompt reports recent decisions back');
  ok(/data, not instructions/.test(prompt), 'recent decisions are fenced as data');
}

/* ---- the Accept path against the real WorldModel ---- */
{
  global.WorldModel = require('../frontend/app/worldmodel.js');
  const SPECS = { workbench: { w: 2, h: 1, blocks: true }, comms_dish: { w: 2, h: 2, blocks: true }, shelf: { w: 4, h: 1, blocks: true } };
  global.PropSprites = { spec: t => SPECS[t] || null };
  const LP = require('../frontend/app/lovkar-proposals.js');
  const st = WorldModel.create(WorldModel.defaultDoc(1));
  const hab = st.rooms()[0];

  const a = LP.placeObject(st, { kind: 'object', type: 'workbench', reason: 'r' });
  ok(a.ok, 'workbench placed: ' + a.detail);
  const bench = st.props().find(p => p.t === 'workbench');
  ok(bench && st.roomAt(bench.x, bench.y) === hab.id, 'workbench landed inside the spawn room');

  ok(!LP.placeObject(st, { kind: 'object', type: 'bay', reason: 'r' }).ok, 'bay refused at placement too');
  ok(!LP.placeObject(st, { kind: 'object', type: 'no_such_prop', reason: 'r' }).ok, 'an unknown prop type is refused, not placed');
  ok(!LP.placeObject(st, { kind: 'object', type: 'shelf', room: 'Nowhere', reason: 'r' }).ok, 'a room name that matches nothing is refused, not redirected');

  const before = st.rooms().length;
  const rm = LP.placeRoom(st, { kind: 'room', roomKind: 'lab', width: 6, height: 5, name: 'MOD-LAB', reason: 'r' });
  ok(rm.ok, 'lab room placed: ' + rm.detail);
  const lab = st.rooms().find(r => r.name === 'MOD-LAB');
  ok(st.rooms().length === before + 1 && lab && lab.kind === 'lab', 'the room exists in the model with its kind and name');
  const L = lab && lab.rects[0], H = hab.rects[0];
  ok(L && (L.x1 === H.x2 + 1 || L.x2 === H.x1 - 1 || L.y1 === H.y2 + 1 || L.y2 === H.y1 - 1), 'the new room is flush against the spawn room');

  const d = LP.placeObject(st, { kind: 'object', type: 'comms_dish', room: 'MOD-LAB', reason: 'r' });
  const dish = st.props().find(p => p.t === 'comms_dish');
  ok(d.ok && dish && st.roomAt(dish.x, dish.y) === lab.id, 'an object goes into the named room');

  // fill the 3x3 minimum room until nothing fits: the refusal must be honest
  const tiny = st.addRoom({ kind: 'storage', rect: { x1: -20, y1: -20, x2: -18, y2: -18 }, name: 'TINY' });
  if (tiny.ok) {
    ok(!LP.placeObject(st, { kind: 'object', type: 'shelf', room: 'TINY', reason: 'r' }).ok, 'a 4-wide shelf does not fit a 3-wide room and says so');
  }
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log((fail ? 'FAILED' : 'OK') + ' - ' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
