'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createCanvas, Image } = require('@napi-rs/canvas');
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'frontend/app/industrialtextures.js'), 'utf8');
async function load(search, broken = false) {
  class AssetImage extends Image {
    set src(url) {
      if (broken && url.includes('wall.png')) { queueMicrotask(() => this.onerror()); return; }
      super.src = fs.readFileSync(path.join(root, 'frontend', url));
    }
  }
  const document = { documentElement: { dataset: {} }, createElement: () => createCanvas(1, 1) };
  const context = { Image: AssetImage, document, location: { search }, URLSearchParams, module: { exports: {} } };
  vm.runInNewContext(source, context);
  await context.module.exports.ready;
  return context.module.exports;
}
(async () => {
  const pack = await load('?textures=industrial');
  assert.equal(pack.enabled(), true);
  const cv = createCanvas(80, 80), raw = cv.getContext('2d');
  raw.translate(7, 9);
  const g = pack.detailContext(raw);
  g.fillStyle = '#555'; g.fillRect(0, 0, 30, 30);
  g.save(); g.beginPath(); g.rect(4, 4, 20, 20); g.clip();
  const gradient = g.createLinearGradient(0, 0, 20, 0);
  gradient.addColorStop(0, '#f00'); gradient.addColorStop(1, '#00f');
  g.fillStyle = gradient; g.fillRect(0, 0, 30, 30); g.restore();
  g.globalCompositeOperation = 'destination-out'; g.fillRect(10, 10, 4, 4);
  g.globalCompositeOperation = 'source-over'; g.setTransform(1, 0, 0, 1, 0, 0);
  g.fillStyle = '#fff'; g.fillRect(50, 50, 5, 5);
  const result = createCanvas(80, 80), rg = result.getContext('2d');
  assert.equal(pack.drawBase(rg, cv), true);
  const alpha = (c, x, y) => c.getImageData(x, y, 1, 1).data[3];
  let samples = 0;
  for (let y = 0; y < 80; y++) for (let x = 0; x < 80; x++) {
    assert.equal(alpha(raw, x, y) > 127, alpha(rg, x, y) > 127, 'geometry alpha at ' + x + ',' + y);
    samples++;
  }
  const a = createCanvas(24, 12), b = createCanvas(24, 12);
  pack.floor(a.getContext('2d'), 0, 0, 12, -1, -1); pack.floor(a.getContext('2d'), 12, 0, 12, 0, -1);
  pack.floor(b.getContext('2d'), 0, 0, 12, 7, 7); pack.floor(b.getContext('2d'), 12, 0, 12, 8, 7);
  assert.deepEqual(a.getContext('2d').getImageData(0, 0, 24, 12).data, b.getContext('2d').getImageData(0, 0, 24, 12).data);
  const missing = await load('?textures=industrial', true);
  assert.equal(missing.enabled(), false); assert.equal(missing.status().failed[0], 'wall');
  const normal = await load(''); assert.equal(normal.enabled(), false);
  assert.equal(normal.detailContext(raw), raw);
  // Verify real prop integration: every facing uses its own art, occupied chair
  // rims match those pixels exactly, and the desk preserves its image aspect.
  const propContext = { module: { exports: {} }, IndustrialTextures: pack,
    document: { createElement: () => createCanvas(1, 1) }, console,
    U: { hash: s => String(s).split('').reduce((h,c) => Math.imul(h ^ c.charCodeAt(0), 16777619), 2166136261) >>> 0, shade: c => c } };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'frontend/app/propsprites.js'), 'utf8'), propContext);
  const props = propContext.module.exports, facings = new Set();
  for (let r = 0; r < 4; r++) for (let m = 0; m < 2; m++) {
    const full = createCanvas(36, 40), front = createCanvas(36, 40);
    const f = { t: 'chair', x: 1, y: 1, w: 1, h: 1, r, m: !!m };
    props.setCtx(full.getContext('2d')); props.draw(f, false);
    props.setCtx(front.getContext('2d')); props.drawSeatFront(f);
    const pixels = c => c.getContext('2d').getImageData(12, 18, 12, 3).data;
    assert.deepEqual(pixels(full), pixels(front), 'occupied rim agrees with facing ' + r + '/' + m);
    facings.add(Buffer.from(full.getContext('2d').getImageData(0, 0, 36, 40).data).toString('base64'));
    assert.equal(front.getContext('2d').getImageData(0, 0, 36, 18).data.some(v => v), false, 'front pass leaves head clear');
    assert.equal(full.getContext('2d').getImageData(0, 24, 36, 16).data.some(v => v), false, 'chair grounded within its tile');
  }
  assert.ok(facings.size >= 4, 'four distinct chair views');
  const calls = [], spy = { save() {}, restore() {}, drawImage(...args) { calls.push(args); } };
  pack.workstation(spy, 12, 12, 24, 12);
  const [im, dx, dy, dw, dh] = calls[0];
  assert.ok(Math.abs(dw / dh - im.width / im.height) < 1e-8, 'no workstation stretching');
  assert.equal(dy + dh, 24, 'desk contacts its original floor line');
  assert.ok(dx >= 11 && dx + dw <= 37, 'desk fits its existing footprint');
  console.log(JSON.stringify({ assets: pack.status(), alphaSamples: samples, chairOrientations: 8,
    seatFrontPixelMatch: 'PASS', workstationAspect: 'PASS', floorContact: 'PASS',
    worldAnchor: 'PASS', missingAssetFallback: 'PASS', normalRenderer: 'PASS' }));
})().catch(err => { console.error(err); process.exitCode = 1; });
