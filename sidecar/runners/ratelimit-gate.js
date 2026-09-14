/* sidecar/runners/ratelimit-gate.js — decide when a subscription-limit line is worth showing.

   Claude Code reports `rate_limit_event` on every run, so relaying each one turns a useful
   instrument into wallpaper: the Commander stops reading it, and then the one that mattered
   goes past unread too.

   So a line is emitted only when the number has actually MOVED, or when its meaning changed:

     · first sighting of a window          — you cannot notice a change you were never shown
     · the bucket changed                  — utilization crossed a step boundary (default 5
                                             points), in either direction. A reset from 78%
                                             to 0% is a change worth one line.
     · the status left "allowed"           — the provider itself started warning
     · overage began                       — a different kind of fact entirely

   PURE and injectable: no clock, no IO, state only in the closure. One gate per process, so
   the memory is per station rather than per run — which is the whole point, since a
   per-run gate would have nothing to compare against.

     makeRateLimitGate({ stepPct? }) -> { shouldNotify(info) -> bool, state() }
*/
'use strict';

function bucketOf(util, stepPct) {
  const u = Number(util);
  if (!isFinite(u) || u < 0) return null;
  const step = stepPct / 100;
  return Math.floor(u / step);
}

function makeRateLimitGate(opts) {
  opts = opts || {};
  const stepPct = Number(opts.stepPct) > 0 ? Number(opts.stepPct) : 5;

  let buckets = Object.create(null);   // window name -> last reported bucket
  let lastStatus = null;
  let lastOverage = null;
  let seen = false;

  function shouldNotify(info) {
    info = info || {};
    const windows = info.unifiedWindows || {};
    const names = Object.keys(windows);

    let move = false;
    for (const n of names) {
      const b = bucketOf(windows[n] && windows[n].utilization, stepPct);
      if (b == null) continue;
      if (!(n in buckets)) { move = true; }        // first sighting of this window
      else if (buckets[n] !== b) { move = true; }  // crossed a step, up or down
      buckets[n] = b;
    }

    const status = info.status == null ? null : String(info.status);
    const statusChanged = status !== lastStatus && !(lastStatus === null && status === 'allowed');
    lastStatus = status;

    const overage = info.isUsingOverage === true;
    const overageChanged = lastOverage !== null && overage !== lastOverage;
    if (lastOverage === null && overage) move = true;   // starting IN overage is worth saying
    lastOverage = overage;

    const first = !seen;
    seen = true;

    return !!(first || move || statusChanged || overageChanged);
  }

  function state() { return { stepPct, buckets: Object.assign({}, buckets), lastStatus, lastOverage, seen }; }

  return { shouldNotify, state };
}

/* The station has ONE subscription, so it gets ONE gate. Both run paths (the runOnce
   short-circuit and POST /api/lovkar/run) share it, which is what makes "only when it moved"
   mean anything across runs. Step overridable by env for a station that wants it chattier. */
let _shared = null;
function sharedRateLimitGate() {
  if (!_shared) {
    const env = Number(process.env.LOVKAR_LIMIT_STEP_PCT);
    _shared = makeRateLimitGate({ stepPct: isFinite(env) && env > 0 ? env : 5 });
  }
  return _shared;
}

module.exports = { makeRateLimitGate, sharedRateLimitGate, bucketOf };
