/* sidecar/routes/lovkar-proposals.js — the station's side of placement proposals.

     GET  /api/lovkar/proposals          -> { pending: [...] }   validated, invalid ones carry `error`
     POST /api/lovkar/proposals/decide   { id, status: accepted|rejected|failed, detail? }

   The sidecar never places anything. The floor lives in the page (WorldModel), so the page
   performs the placement through the same validated addProp/addRoom a hand placement uses and
   then reports what ACTUALLY happened here. `accepted` means it is on the floor; a placement the
   world model refused is recorded as `failed` with its reason.

     makeLovkarProposals({ vaultRoot }) -> { handleList, handleDecide, proposals }
*/
'use strict';

const { makeProposals } = require('../vault/proposals.js');
const { resolveVaultRoot } = require('../vault/vault-root.js');

const MAX_BODY = 4096;

function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on('data', c => {
      n += c.length;
      if (n > cap) { reject(new Error('body too large')); try { req.destroy(); } catch (_) {} return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function makeLovkarProposals(deps) {
  deps = deps || {};
  const proposals = makeProposals({ root: deps.vaultRoot || resolveVaultRoot({ cwd: deps.cwd }) });

  async function handleList(req, res) {
    try { send(res, 200, { pending: proposals.list() }); }
    catch (e) { send(res, 500, { error: (e && e.message) || 'list failed' }); }
  }

  async function handleDecide(req, res) {
    let body;
    try { body = JSON.parse(await readBody(req, MAX_BODY) || '{}'); }
    catch (_) { return send(res, 400, { error: 'bad json' }); }
    let r;
    try { r = proposals.decide(body.id, { status: body.status, detail: body.detail }); }
    catch (e) { return send(res, 500, { error: (e && e.message) || 'decide failed' }); }
    send(res, r.ok ? 200 : 400, r);
  }

  return { handleList, handleDecide, proposals };
}

module.exports = { makeLovkarProposals };
