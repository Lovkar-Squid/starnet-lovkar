/* StarNet industrial material study, September 2026.
 * Image-authored albedo; geometry, lighting, seats and live activity remain owned
 * by the station renderer. Enable the review build with ?textures=industrial.
 * A failed or pending asset keeps the complete existing material set visible.
 */
'use strict';
const IndustrialTextures = (() => {
  let requested = false;
  try { requested = new URLSearchParams(location.search).get('textures') === 'industrial'; } catch (_) {}
  const images = {}, failed = [];
  // Exposed to the existing CRT lab for a live, reproducible material review.
  const lighting = { fixtureTint: .04 };
  const plates = new WeakMap();
  let loaded = false;
  const names = ['floor', 'wall', 'shell', 'workstation', 'chair-s', 'chair-e', 'chair-n'];
  // The references are already lit pictures. These measured albedo gains keep
  // the existing light simulation from applying a second exposure to the art.
  const gain = { floor: 1.25, wall: 2.4, shell: 2.05, workstation: 1.5,
    'chair-s': 1.8, 'chair-e': 1.8, 'chair-n': 1.8 };
  const ready = requested && typeof Image !== 'undefined' ? Promise.all(names.map(name => new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      try {
        const cv = document.createElement('canvas'); cv.width = img.width; cv.height = img.height;
        const ctx = cv.getContext('2d');
        ctx.filter = 'brightness(' + gain[name] + ')'; ctx.drawImage(img, 0, 0);
        images[name] = cv;
      } catch (_) { failed.push(name); }
      resolve();
    };
    img.onerror = () => { failed.push(name); resolve(); };
    img.src = 'assets/industrial/' + name + '.png';
  }))).then(() => {
    loaded = !failed.length;
    document.documentElement.dataset.texturePack = loaded ? 'industrial' : 'fallback';
  }) : Promise.resolve();
  const enabled = () => requested && loaded;
  const mod = (n, d) => ((n % d) + d) % d;

  // Tee the base painter into a denser art plate. The original canvas remains
  // the exact geometry/alpha/readback authority for lights, chunks and picking.
  // Only the final visible blit uses the denser plate; simulation units stay 12px.
  function detailContext(ctx) {
    if (!enabled()) return ctx;
    const source = ctx.canvas, scale = Math.min(3, 4096 / Math.max(source.width, source.height));
    if (scale < 1.5) return ctx;
    const cv = document.createElement('canvas'); cv.width = Math.ceil(source.width * scale); cv.height = Math.ceil(source.height * scale);
    const g = cv.getContext('2d'), transform = ctx.getTransform();
    g.scale(scale, scale); g.transform(transform.a, transform.b, transform.c, transform.d, transform.e, transform.f);
    g.imageSmoothingEnabled = false;
    const paintObjects = new WeakMap();
    plates.set(source, cv);
    if (cv.addEventListener) cv.addEventListener('contextlost', () => plates.delete(source), { once: true });
    document.documentElement.dataset.textureResolution = String(scale);
    return new Proxy(ctx, {
      set(target, key, value) { target[key] = value; g[key] = paintObjects.get(value) || value; return true; },
      get(target, key) {
        const value = target[key]; if (typeof value !== 'function') return value;
        if (['getImageData', 'getTransform', 'measureText', 'isPointInPath', 'isPointInStroke', 'getContextAttributes'].includes(key)) return value.bind(target);
        if (key === 'setTransform' || key === 'resetTransform') return (...args) => {
          value.apply(target, args);
          const m = target.getTransform();
          g.setTransform(m.a * scale, m.b * scale, m.c * scale, m.d * scale, m.e * scale, m.f * scale);
        };
        if (key === 'createLinearGradient' || key === 'createRadialGradient' || key === 'createPattern') return (...args) => {
          const a = target[key](...args), b = g[key](...args);
          if (a && b) {
            paintObjects.set(a, b);
            for (const method of ['addColorStop', 'setTransform']) if (typeof a[method] === 'function') {
              const original = a[method].bind(a);
              a[method] = (...params) => { b[method](...params); return original(...params); };
            }
          }
          return a;
        };
        return (...args) => { const result = value.apply(target, args); g[key](...args); return result; };
      }
    });
  }
  function drawBase(ctx, cv, x = 0, y = 0) {
    const hi = enabled() && plates.get(cv);
    if (!hi) return false;
    ctx.save(); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(hi, x, y, cv.width, cv.height); ctx.restore(); return true;
  }

  function floor(ctx, X, Y, size, tx, ty) {
    if (!enabled()) return false;
    const im = images.floor, period = 8;
    ctx.save(); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(im, mod(tx, period) * im.width / period, mod(ty, period) * im.height / period,
      im.width / period, im.height / period, X, Y, size, size);
    ctx.restore(); return true;
  }
  function wall(ctx, X, Y, width, height, tx) {
    if (!enabled()) return false;
    const im = images.wall;
    // One structural bay spans four game tiles. This matches the side/corner
    // face-strip period, so the same material wraps without an extra seam.
    ctx.save(); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(im, mod(tx, 4) * im.width / 16, 0, im.width / 16, im.height, X, Y, width, height);
    ctx.restore(); return true;
  }
  function shell(ctx, width, height, vx, vy, topOf) {
    if (!enabled()) return false;
    const im = images.shell, period = 96;
    ctx.save(); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    // Sample each column relative to its actual contour top. The geometry's
    // alpha mask and exposure pass still clip and shade the resulting cladding.
    for (let x = 0; x < width; x++) {
      const top = topOf && topOf[x] >= 0 ? topOf[x] : -vy;
      for (let y = 0; y < height;) {
        const sy = mod(y - top, period), h = Math.min(period - sy, height - y);
        ctx.drawImage(im, mod(vx + x, period) * im.width / period, sy * im.height / period,
          im.width / period, h * im.height / period, x, y, 1, h);
        y += h;
      }
      const shade = ctx.createLinearGradient(0, top, 0, top + 40);
      shade.addColorStop(0, 'rgba(0,0,0,0.12)'); shade.addColorStop(1, 'rgba(0,0,0,0.72)');
      ctx.fillStyle = shade; ctx.fillRect(x, 0, 1, height);
    }
    ctx.restore(); return true;
  }
  function shellPlate(ctx, x, y, width, height) {
    if (!enabled()) return false;
    ctx.save(); ctx.imageSmoothingEnabled = true;
    for (let yy = y; yy < y + height; yy += 96) for (let xx = x; xx < x + width; xx += 96) {
      const w = Math.min(96, x + width - xx), h = Math.min(96, y + height - yy), im = images.shell;
      ctx.drawImage(im, 0, 0, im.width * w / 96, im.height * h / 96, xx, yy, w, h);
    }
    ctx.restore(); return true;
  }
  function workstation(ctx, x, y, w, h) {
    if (!enabled()) return false;
    // Fit without stretching: footprint controls width, ground contact controls
    // the bottom. The compact operator console has its own correctly sized art.
    const im = images.workstation, scale = Math.min((w + 2) / im.width, (h + 14) / im.height);
    const dw = im.width * scale, dh = im.height * scale;
    ctx.save(); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(im, x + (w - dw) / 2, y + h - dh, dw, dh);
    ctx.restore(); return true;
  }
  function chair(ctx, x, y, w, h, facing = 's') {
    if (!enabled()) return false;
    const im = images['chair-' + facing], scale = Math.min(w / im.width, (h + 4) / im.height);
    const dw = im.width * scale, dh = im.height * scale;
    ctx.save(); ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(im, x + (w - dw) / 2, y + h - dh, dw, dh);
    ctx.restore(); return true;
  }
  return Object.freeze({ ready, enabled, lighting, detailContext, drawBase, floor, wall, shell, shellPlate, workstation, chair,
    status: () => ({ requested, loaded, failed: failed.slice(), assets: Object.keys(images) }) });
})();
if (typeof module !== 'undefined' && module.exports) module.exports = IndustrialTextures;
