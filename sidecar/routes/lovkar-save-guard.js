/* sidecar/routes/lovkar-save-guard.js — a locked save is not a missing save.

   THE BUG THIS EXISTS FOR (measured 2026-09-15, the fourth recurrence of "it opened on onboarding"):

   savestore.js reads the save file into a TAGGED result and is careful about the difference:

     absent      ENOENT — there really is no save
     unreadable  the file EXISTS but a non-ENOENT errno blocked the read (EBUSY/EACCES/EPERM —
                 on Windows: another sidecar still holding it, a virus scanner mid-scan, a
                 backup agent, an indexer)
     corrupt     read, but the bytes do not parse

   Its back-compat `load()` then throws that distinction away — `readWrapper` returns undefined
   for all three — and `serveSaveLoad` answers `{ save: null }`. To the frontend, "your station
   is locked for 200 ms" and "you have never used this app" are the same sentence, so it runs
   the first-run ceremony over a station that is sitting on disk, intact.

   Evidence from the 11:10 occurrence: at 11:11:26 the save store reported NO SAVE while
   `agent.save.json` existed untouched from 05:44:52 (creation time proves it was never
   replaced), and a directory listing of the workspace returned 16 of its 66 files — a partial
   enumeration, which is what a directory looks like while something else holds it. Seven
   minutes later, the identical check read the save back fine. Nothing was lost at any point;
   the app simply asked once, at the wrong moment, and took "no" for an answer.

   THE FIX: ask again. An `unreadable` result is retried on a short bounded backoff, because
   this class of lock clears in milliseconds. If it is still locked when the budget runs out we
   say so explicitly (`busy`) instead of reporting an empty station — a caller can then show a
   real message and retry, and must never present onboarding.

   The sleep is synchronous (Atomics.wait) because `serveSaveLoad` is synchronous, and it only
   ever runs on the failure path: a healthy boot does one read and never sleeps at all.

     loadGuarded(saveStore, agentId, opts?) -> {
       doc,            // the save envelope, or null
       status,         // 'ok' | 'absent' | 'busy' | 'corrupt'
       attempts,       // how many reads it took
       waitedMs,       // total time spent waiting
       code            // the errno that blocked it, when status === 'busy'
     }

   Pure except for the injected sleep: every I/O goes through the saveStore handed in, so the
   tests drive it with a fake store that fails a chosen number of times. */

'use strict';

// The backoff schedule, in ms. Four retries over ~0.6 s total — long enough for a scanner or a
// dying sidecar to let go, short enough that a genuinely absent save still boots promptly.
// A first-run user never reaches it: 'absent' returns immediately, without a single wait.
const BACKOFF_MS = Object.freeze([40, 80, 160, 320]);

// Synchronous sleep. Node permits Atomics.wait on the main thread (browsers do not), and this
// is the one place the route can afford to block: a save that exists but cannot be read is
// worth 600 ms to get right, because the alternative is telling the user their station is gone.
function sleepSync(ms) {
  if (!(ms > 0)) return 0;
  try {
    const sab = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(sab, 0, 0, ms);
    return ms;
  } catch (_) {
    // No SharedArrayBuffer (an exotic runtime or a flag-restricted build): spin the clock
    // instead. Same bounded cost, and still only on the failure path.
    const until = Date.now() + ms;
    while (Date.now() < until) { /* burn */ }
    return ms;
  }
}

// Reach the tagged read through the store's own internals so this file owns no path logic and
// no parsing of its own — if savestore's layout ever changes, this follows it. Returns null when
// the store predates _internals, which makes the guard degrade to plain load().
function tagOf(saveStore, agentId) {
  try {
    const int = saveStore && saveStore._internals;
    if (!int || typeof int.readTagged !== 'function' || typeof int.saveFile !== 'function') return null;
    return int.readTagged(int.saveFile(agentId));
  } catch (_) {
    return null;   // a bad agentId throws in saveFile; the caller validated it, so treat as unknown
  }
}

function loadGuarded(saveStore, agentId, opts) {
  const o = opts || {};
  const schedule = Array.isArray(o.backoffMs) ? o.backoffMs : BACKOFF_MS;
  const sleep = typeof o.sleep === 'function' ? o.sleep : sleepSync;
  const log = typeof o.log === 'function' ? o.log : function () {};

  let attempts = 0;
  let waitedMs = 0;
  let lastCode = null;

  for (let i = 0; ; i++) {
    attempts++;
    let doc = null;
    try { doc = saveStore.load(agentId) || null; } catch (_) { doc = null; }
    if (doc) {
      if (attempts > 1) log('save read succeeded on attempt ' + attempts + ' after ' + waitedMs + 'ms of lock contention');
      return { doc: doc, status: 'ok', attempts: attempts, waitedMs: waitedMs, code: null };
    }

    const tag = tagOf(saveStore, agentId);

    // No tagged read available (old store) — nothing to distinguish, keep the legacy answer.
    if (!tag) return { doc: null, status: 'absent', attempts: attempts, waitedMs: waitedMs, code: null };

    // A genuinely new user. Return at once: never make a first run wait.
    if (tag.status === 'absent') return { doc: null, status: 'absent', attempts: attempts, waitedMs: waitedMs, code: null };

    // Unparseable bytes. savestore has already quarantined the main and, where it could, recovered
    // the .bak during load() above — retrying cannot help, and the recovery notice carries the story.
    if (tag.status === 'corrupt') return { doc: null, status: 'corrupt', attempts: attempts, waitedMs: waitedMs, code: (tag.err && tag.err.code) || null };

    // status === 'unreadable' (or 'ok' with no usable doc — an envelope without .doc, equally not
    // something a retry fixes, but cheap to treat the same and it cannot loop: the schedule is finite).
    lastCode = (tag.err && tag.err.code) || lastCode;
    if (tag.status !== 'unreadable') {
      return { doc: null, status: 'absent', attempts: attempts, waitedMs: waitedMs, code: null };
    }

    if (i >= schedule.length) {
      log('save file EXISTS but stayed unreadable (' + (lastCode || 'EUNKNOWN') + ') after ' + attempts +
          ' attempts over ' + waitedMs + 'ms — reporting BUSY, not an empty station');
      return { doc: null, status: 'busy', attempts: attempts, waitedMs: waitedMs, code: lastCode };
    }
    waitedMs += sleep(schedule[i]);
  }
}

module.exports = { loadGuarded, BACKOFF_MS, _internals: { sleepSync, tagOf } };
