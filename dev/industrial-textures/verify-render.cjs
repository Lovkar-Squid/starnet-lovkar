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
  console.log(JSON.stringify({ assets: pack.status(), alphaSamples: samples, worldAnchor: 'PASS', missingAssetFallback: 'PASS', normalRenderer: 'PASS' }));
})().catch(err => { console.error(err); process.exitCode = 1; });
