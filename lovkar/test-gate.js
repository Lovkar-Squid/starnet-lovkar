/* lovkar/test-gate.js — the subscription-limit line should be rare and never miss a change. */
'use strict';
const path = require('path');
const { makeRateLimitGate } = require(path.join(path.resolve(__dirname, '..'), 'sidecar', 'runners', 'ratelimit-gate.js'));

let fail = 0, pass = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ok   ' + m); } else { fail++; console.log('  FAIL ' + m); } };
const info = (five, seven, extra) => Object.assign({ status: 'allowed', isUsingOverage: false,
  unifiedWindows: { five_hour: { utilization: five }, seven_day: { utilization: seven } } }, extra || {});

console.log('\n-- it speaks once, then goes quiet --');
{
  const g = makeRateLimitGate({ stepPct: 5 });
  ok(g.shouldNotify(info(0.03, 0.78)) === true, 'first sighting is always shown');
  ok(g.shouldNotify(info(0.03, 0.78)) === false, 'the same numbers say nothing');
  ok(g.shouldNotify(info(0.04, 0.78)) === false, 'drifting inside a bucket says nothing');
  ok(g.shouldNotify(info(0.06, 0.78)) === true, '5% -> crossing a step speaks');
  ok(g.shouldNotify(info(0.07, 0.78)) === false, 'and then goes quiet again');
}

console.log('\n-- twenty runs of slow drift, not twenty lines --');
{
  const g = makeRateLimitGate({ stepPct: 5 });
  let spoke = 0;
  for (let i = 0; i < 20; i++) if (g.shouldNotify(info(0.10 + i * 0.002, 0.78))) spoke++;
  ok(spoke <= 2, 'at most 2 lines across a 4-point drift (' + spoke + ')');
}

console.log('\n-- but it never misses something that matters --');
{
  const g = makeRateLimitGate({ stepPct: 5 });
  g.shouldNotify(info(0.50, 0.50));
  ok(g.shouldNotify(info(0.50, 0.50, { status: 'allowed_warning' })) === true, 'the provider starting to warn speaks');
  ok(g.shouldNotify(info(0.50, 0.50, { status: 'allowed_warning' })) === false, 'the same warning does not repeat');
  ok(g.shouldNotify(info(0.50, 0.50, { status: 'allowed_warning', isUsingOverage: true })) === true, 'entering overage speaks');
}

console.log('\n-- a window reset is a change, not a silence --');
{
  const g = makeRateLimitGate({ stepPct: 5 });
  g.shouldNotify(info(0.80, 0.80));
  ok(g.shouldNotify(info(0.00, 0.80)) === true, 'dropping back to zero speaks');
}

console.log('\n-- garbage in, no crash --');
{
  const g = makeRateLimitGate({ stepPct: 5 });
  ok(typeof g.shouldNotify({}) === 'boolean', 'empty info is answered, not thrown');
  ok(typeof g.shouldNotify({ unifiedWindows: { x: { utilization: 'nope' } } }) === 'boolean', 'nonsense utilization is survived');
}

console.log('\n' + (fail === 0 ? '✅ PASS — ' + pass + ' checks' : '❌ FAIL — ' + fail));
process.exit(fail === 0 ? 0 : 1);
