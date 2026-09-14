/* lovkar-proposals.js — Accept / Reject for rooms and objects an agent has PROPOSED.
 *
 * An agent cannot place anything: each object on the floor is a capability grant, and only the
 * Commander grants. An agent writes a proposal file into the vault; the sidecar validates it and
 * serves it at GET /api/lovkar/proposals; this card shows it. Accept places it through the SAME
 * validated WorldModel mutations a hand placement uses (canPlaceProp/addProp, canPlaceRoom/addRoom),
 * persists, and reports the REAL outcome back — a placement the model refused is recorded as
 * `failed` with its reason, never as accepted.
 *
 * Proposal text is model output. Everything shown is set through textContent, never innerHTML.
 */
'use strict';

const LovkarProposals = (() => {
  const POLL_MS = 4000;
  const REFUSED = { bay: 1, connector_portal: 1 };
  let card = null, timer = null, busy = false, shown = '';
  const skipped = new Set();   // ids dismissed with "later" for this page session

  const station = () => {
    try { return (typeof App !== 'undefined' && App.lovkarStation) ? App.lovkarStation() : null; } catch (_) { return null; }
  };
  const specOf = t => (typeof PropSprites !== 'undefined' && PropSprites.spec) ? PropSprites.spec(t) : null;
  const grantOf = t => (typeof WorldModel !== 'undefined' && WorldModel.grantLabelForProp) ? WorldModel.grantLabelForProp(t) : null;

  /* WHERE: a room named in the proposal, else the proposing agent's own room, else the hero's,
     else the spawn room. A name that matches nothing is a refusal, not a silent fallback. */
  function targetRoom(st, p) {
    const rooms = (st.rooms && st.rooms()) || [];
    if (p.room) {
      const want = String(p.room).toLowerCase();
      const hit = rooms.filter(r => r.id === p.room || String(r.name || '').toLowerCase() === want);
      if (hit.length !== 1) return { error: 'no room called "' + p.room + '"' };
      return { room: hit[0] };
    }
    for (const aid of [p.agent, 'agent']) {
      if (!aid || !st.agentRoomId) continue;
      const id = st.agentRoomId(aid);
      if (id && st.roomById(id)) return { room: st.roomById(id) };
    }
    const sid = st.spawnRoomId && st.spawnRoomId();
    return sid && st.roomById(sid) ? { room: st.roomById(sid) } : { error: 'the station has no room yet' };
  }

  function placeObject(st, p) {
    if (REFUSED[p.type]) return { ok: false, detail: p.type + ' must be placed by hand' };
    const s = specOf(p.type);
    if (!s) return { ok: false, detail: 'unknown object type "' + p.type + '"' };
    const tr = targetRoom(st, p);
    if (tr.error) return { ok: false, detail: tr.error };
    const w = Math.max(1, s.w | 0 || 1), h = Math.max(1, s.h | 0 || 1);
    for (const r of tr.room.rects) {
      for (let y = r.y1; y <= r.y2 - h + 1; y++) {
        for (let x = r.x1; x <= r.x2 - w + 1; x++) {
          if (st.roomAt(x, y) !== tr.room.id || st.roomAt(x + w - 1, y + h - 1) !== tr.room.id) continue;
          if (!(st.canPlaceProp(p.type, x, y, w, h) || {}).ok) continue;
          const res = st.addProp({ t: p.type, x, y, w, h, block: s.blocks !== false });
          if (res && res.ok) return { ok: true, detail: 'placed in ' + (tr.room.name || tr.room.id) + ' at ' + x + ',' + y };
          return { ok: false, detail: (res && (res.msg || res.error)) || 'placement refused' };
        }
      }
    }
    return { ok: false, detail: 'no free tile for ' + p.type + ' in ' + (tr.room.name || tr.room.id) };
  }

  /* A new room goes FLUSH against the target room, so the two share a wall and the door derives
     the way it does for a hand-built room. Tries each side, centred first, then sliding along. */
  function placeRoom(st, p) {
    const tr = targetRoom(st, Object.assign({}, p, { agent: p.agent }));
    if (tr.error) return { ok: false, detail: tr.error };
    const W = p.width, H = p.height, cands = [];
    for (const o of tr.room.rects) {
      const cx = Math.round((o.x1 + o.x2) / 2 - (W - 1) / 2), cy = Math.round((o.y1 + o.y2) / 2 - (H - 1) / 2);
      const slides = [0];
      for (let d = 1; d <= Math.max(W, H, o.x2 - o.x1, o.y2 - o.y1); d++) slides.push(d, -d);
      for (const d of slides) {
        cands.push({ x1: o.x2 + 1, y1: cy + d, x2: o.x2 + W, y2: cy + d + H - 1 });   // east
        cands.push({ x1: o.x1 - W, y1: cy + d, x2: o.x1 - 1, y2: cy + d + H - 1 });   // west
        cands.push({ x1: cx + d, y1: o.y2 + 1, x2: cx + d + W - 1, y2: o.y2 + H });   // south
        cands.push({ x1: cx + d, y1: o.y1 - H, x2: cx + d + W - 1, y2: o.y1 - 1 });   // north
      }
    }
    for (const rect of cands) {
      // must still touch the target along a shared edge after sliding, or no door can form
      const touches = tr.room.rects.some(o =>
        ((rect.x1 === o.x2 + 1 || rect.x2 === o.x1 - 1) && rect.y1 <= o.y2 - 1 && rect.y2 >= o.y1 + 1) ||
        ((rect.y1 === o.y2 + 1 || rect.y2 === o.y1 - 1) && rect.x1 <= o.x2 - 1 && rect.x2 >= o.x1 + 1));
      if (!touches) continue;
      if (!(st.canPlaceRoom([rect], p.roomKind) || {}).ok) continue;
      const opts = { kind: p.roomKind, rect };
      if (p.name) opts.name = p.name;
      const res = st.addRoom(opts);
      if (res && res.ok) return { ok: true, detail: p.roomKind + ' ' + W + 'x' + H + ' beside ' + (tr.room.name || tr.room.id) };
      return { ok: false, detail: (res && (res.msg || res.error)) || 'room refused' };
    }
    return { ok: false, detail: 'no free space beside ' + (tr.room.name || tr.room.id) + ' for a ' + W + 'x' + H + ' room' };
  }

  async function decide(p, status, detail) {
    const r = await fetch('/api/lovkar/proposals/decide', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: p.id, status, detail: detail || '' })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.ok) throw new Error(j.error || ('HTTP ' + r.status));
    return j;
  }

  async function accept(p) {
    const st = station();
    if (!st) return say('The station is not loaded yet.');
    let out;
    try { out = p.kind === 'room' ? placeRoom(st, p) : placeObject(st, p); }
    catch (e) { out = { ok: false, detail: (e && e.message) || 'placement threw' }; }
    if (out.ok) { try { App.persist(); } catch (_) {} }
    try { await decide(p, out.ok ? 'accepted' : 'failed', out.detail); }
    catch (e) { return say((out.ok ? 'Placed, but the decision was not recorded: ' : 'Could not record: ') + e.message); }
    say(out.ok ? 'Placed: ' + out.detail : 'Not placed: ' + out.detail);
  }

  function el(tag, css, text) {
    const n = document.createElement(tag);
    if (css) n.style.cssText = css;
    if (text != null) n.textContent = text;
    return n;
  }
  const BTN = 'font:inherit;padding:4px 10px;margin-right:6px;cursor:pointer;border:1px solid #5a7;background:#132;color:#cfe;';

  function ensureCard() {
    if (card) return card;
    card = el('div', 'position:fixed;right:16px;bottom:16px;z-index:99999;max-width:340px;padding:10px 12px;'
      + 'font:12px/1.4 monospace;color:#dfe;background:rgba(8,16,22,.94);border:1px solid #4a8;box-shadow:0 0 0 2px #000;display:none;');
    card.setAttribute('data-lovkar', 'proposals');
    document.body.appendChild(card);
    return card;
  }

  let note = '', noteUntil = 0;
  function say(msg) { note = msg; noteUntil = Date.now() + 6000; shown = ''; poll(); }

  function render(list) {
    const c = ensureCard();
    const rows = list.filter(p => !skipped.has(p.id));
    const showNote = note && Date.now() < noteUntil;
    const key = JSON.stringify(rows.map(p => p.id)) + (showNote ? note : '');
    if (key === shown) return;
    shown = key;
    c.textContent = '';
    if (!rows.length && !showNote) { c.style.display = 'none'; return; }
    c.style.display = 'block';
    if (showNote) c.appendChild(el('div', 'color:#fd8;margin-bottom:6px;', note));
    const p = rows[0];
    if (!p) return;
    c.appendChild(el('div', 'color:#8fc;letter-spacing:1px;margin-bottom:4px;',
      'PROPOSAL' + (rows.length > 1 ? ' 1/' + rows.length : '') + (p.agent ? ' - from ' + p.agent : '')));
    if (!p.ok) {
      c.appendChild(el('div', 'color:#f99;', 'Invalid proposal "' + p.id + '": ' + p.error));
    } else if (p.kind === 'object') {
      const g = grantOf(p.type);
      c.appendChild(el('div', '', 'Place object: ' + p.type + (g ? '  (grants ' + g + ')' : '') + (p.room ? ' in ' + p.room : '')));
    } else {
      c.appendChild(el('div', '', 'Build room: ' + p.roomKind + ' ' + p.width + 'x' + p.height + (p.name ? ' "' + p.name + '"' : '')));
    }
    if (p.ok) c.appendChild(el('div', 'color:#abc;margin:4px 0 8px;', p.reason));
    const bar = el('div', 'margin-top:6px;');
    const act = (label, fn, css) => {
      const b = el('button', BTN + (css || ''), label);
      b.onclick = async () => { if (busy) return; busy = true; try { await fn(); } finally { busy = false; shown = ''; poll(); } };
      bar.appendChild(b);
    };
    if (p.ok) act('ACCEPT', () => accept(p));
    act('REJECT', () => decide(p, 'rejected', 'rejected by the Commander').then(() => say('Rejected.'), e => say('Could not record: ' + e.message)), 'border-color:#a55;background:#311;');
    act('LATER', async () => { skipped.add(p.id); }, 'border-color:#666;background:#222;');
    c.appendChild(bar);
  }

  async function poll() {
    if (busy || (typeof document !== 'undefined' && document.hidden)) return;
    if (!station()) return;
    try {
      const r = await fetch('/api/lovkar/proposals', { cache: 'no-store' });
      if (!r.ok) return;
      const j = await r.json();
      render(Array.isArray(j.pending) ? j.pending : []);
    } catch (_) {}
  }

  function start() {
    if (timer || typeof window === 'undefined') return;
    timer = setInterval(poll, POLL_MS);
    setTimeout(poll, 1500);
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
  }

  return { poll, placeObject, placeRoom, targetRoom };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = LovkarProposals;
