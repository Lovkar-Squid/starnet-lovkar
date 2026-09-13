> WITHDRAWN at the user's request on 2026-09-13. Commit db81726b19ebfeae6c83d124549fef32cc5ea889 reverts the SVG swap. The previous PNG header is restored in production deployment 1952e6b6-e388-4f54-ae65-ff30b18c8243. Do not integrate the earlier SVG candidate; the restored header already matches trunk. See 2026-09-13-website-logo-restored.md.

# Sharp website wordmark — 2026-09-13

Published source: f05b3d586c8a4d23ffc34a0c9778ccd54a1caa48 on agent/website-sharp-logo-0913.
Header change commit: ebccac13345ca020078d968a303a310f14799392.

The shared website header now uses the app's canonical mosaic SVG wordmark through a CSS mask instead of the compact raster PNG. The asset is copied byte-for-byte from frontend/assets/brand/starnet-wordmark.svg (SHA256 2c469684a936d5236cf646971c5a9f80bd5b5b60792669deebd19ea18ad0218d). It renders at 30px desktop / 24px mobile with no filter or glow. The accessible home link, VT323 navigation, GitHub alignment and removed Agent station subtitle are retained. The shared shell regenerated all 31 pages with a fresh stylesheet cache version.

Verification:
- Local browser: home, docs, nested guides, privacy and 404 at 320, 390, 768 and 1440px; all 20 combinations had aligned navigation text and header links within the viewport. Header-only visual crops confirmed the SVG at desktop and mobile size. Logo link returned to /index.html.
- The sync from trunk 0b35b46e91a80ecaa7c39a7fcec5fae512157a86 changed no header, docs or logo bytes. Final hosted preview and public homepage verified the visible SVG with no filter.
- Shared shell check: 31 pages, zero drift. Navigation: 1323 assertions / 1079 internal links. Guarded deployment staging: 25 assertions.
- Exact published source CI: https://github.com/androoAGI/starnet/actions/runs/34737464288 — npm run test:fast 772/772 and customer journeys 34/34 passed.
- Final preview: https://8a16b3da.starnet-site.pages.dev.
- Production: https://starnetos.com/ — deployment ea4d9bbd-481b-4ca9-8646-61994b79722b, https://ea4d9bbd.starnet-site.pages.dev, source f05b3d5. All 24 documentation pages, 13 assets including the SVG, and 5 other pages match guarded staging (HTML comparison reverses Cloudflare email obfuscation only).
- Rollback deployment: 8c6c9a8a-b81a-405b-8afb-ca3a949c33e1, source 6e076c5d28895d19f938c9eaadc5e1fe21178cf3.

Historical integration attempt (superseded; the SVG candidate is withdrawn): two exact fast-forward attempts failed because C:/Users/andro/Desktop/gen/.git/index.lock is actively held by another process. It was not removed or overridden. Trunk remained 0b35b46e91a80ecaa7c39a7fcec5fae512157a86. Foreign docs/NEXT.md, qa/STATUS.md and docs/HANDOFF_ROOMS_2026-09-04.md hashes were verified before both attempts and no integration edits occurred. Do not merge that source: the owner subsequently withdrew this logo change and the branch now contains its revert. These notes are on the owned branch only, so they do not replace another agent's uncommitted QA status.

This receipt covers the website correction only; it does not assert desktop release readiness.
