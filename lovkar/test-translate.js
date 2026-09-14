/* lovkar/test-translate.js — the Phase 1 correctness gate.

   Replays the REAL faza-0 dumps through the pure translator and asserts that every single
   emitted event validates against the frozen shared/events.js schema. If this passes, the
   station can render the run: the frontend listens to exactly these names and payloads.

   Run:  node lovkar/test-translate.js
*/
'use strict';
const fs = require('fs');
const path = require('path');

const repo = path.resolve(__dirname, '..');
const events = require(path.join(repo, 'shared', 'events.js'));
const { makeTranslator } = require(path.join(repo, 'sidecar', 'runners', 'claudecode-translate.js'));

const FIXTURES = process.argv.slice(2);
if (!FIXTURES.length) { console.error('usage: node lovkar/test-translate.js <dump.jsonl> [...]'); process.exit(2); }

let failures = 0;
let totalEvents = 0;

for (const file of FIXTURES) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(l => l.trim());
  const tr = makeTranslator({ agentId: 'a1', runId: 'r1', trigger: 'directive' });
  const emitted = [];
  let now = 1000;

  for (const line of lines) {
    let o; try { o = JSON.parse(line); } catch (e) { continue; }
    now += 10;
    for (const e of tr.ingest(o, now)) emitted.push(e);
  }
  for (const e of tr.finish({ code: 0 })) emitted.push(e);

  const counts = {};
  for (const e of emitted) {
    counts[e.name] = (counts[e.name] || 0) + 1;
    totalEvents++;
    const v = events.validate(e.name, e.payload);
    if (!v.ok) {
      failures++;
      console.error('  ✗ ' + e.name + ' — ' + JSON.stringify(v.errors));
      console.error('    payload: ' + JSON.stringify(e.payload).slice(0, 300));
    }
  }

  const s = tr.state();
  console.log('\n' + path.basename(file) + '  (' + lines.length + ' lines → ' + emitted.length + ' events)');
  for (const k of Object.keys(counts).sort()) console.log('   ' + String(counts[k]).padStart(4) + '  ' + k);
  console.log('   state: turns=' + s.turns + ' toolCalls=' + s.toolCalls + ' textChars=' + s.text.length + ' session=' + (s.sessionId ? 'yes' : 'no'));

  // structural invariants the station depends on
  const names = emitted.map(e => e.name);
  const check = (cond, msg) => { if (!cond) { failures++; console.error('  ✗ INVARIANT: ' + msg); } };
  check(names[0] === 'agent.run.start' || names.indexOf('agent.run.start') >= 0, 'run.start must be emitted');
  check(names.indexOf('agent.run.start') < names.lastIndexOf('agent.run.end'), 'run.start must precede run.end');
  check(names.filter(n => n === 'agent.run.start').length === 1, 'exactly one run.start');
  check(names.filter(n => n === 'agent.run.end').length === 1, 'exactly one run.end');
  const on = names.filter(n => n === 'agent.reasoning').length;
  check(on % 2 === 0, 'agent.reasoning must be balanced on/off (' + on + ' seen)');
  const calls = emitted.filter(e => e.name === 'agent.tool_call').map(e => e.payload.callId);
  const results = emitted.filter(e => e.name === 'agent.tool_result').map(e => e.payload.callId);
  for (const id of results) check(calls.indexOf(id) >= 0, 'tool_result ' + id + ' has no matching tool_call');
}

console.log('\n' + (failures === 0
  ? '✅ PASS — ' + totalEvents + ' events, all valid against the frozen contract'
  : '❌ FAIL — ' + failures + ' problem(s)'));
process.exit(failures === 0 ? 0 : 1);
