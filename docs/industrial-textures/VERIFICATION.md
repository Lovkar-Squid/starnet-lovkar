# Industrial station verification — 2026-09-12

Local running edition: `http://127.0.0.1:18792/?textures=industrial`.
The backend was launched with `node dev/seed.js --keep`; `/api/health` returned
`"ok"`. This is the isolated preview workspace, not the installed desktop build.

## Observed in the running app

- The page loaded all four industrial assets and exposed `data-texture-pack="industrial"`
  and `data-texture-resolution="3"` on the document element.
- The station displayed the new floor, north wall, side walls, chamfers, exterior
  skirt, and three workstations. NOVA moved between different floor positions.
- The visible state reached `UPLINK ONLINE`, `COMMS online`, and `FEED: LIVE`.
- Refit reported `1 ROOM · 396 TILES · 3 OBJECTS`.
- Clicking the center workstation in Refit opened `ASSIGN AGENT TO WORKSTATION`
  with NOVA available and the current agent ID `agent` retained.
- Canceling the picker and choosing Done produced `Station layout saved`.
  Reload retained the station and the industrial material edition.
- Browser error-log query after reload returned `[]`.

## Rendering checks

`dev/industrial-textures/verify-render.cjs` ran with the bundled `@napi-rs/canvas`:

```json
{"assets":{"requested":true,"loaded":true,"failed":[],"assets":["floor","wall","shell","workstation"]},"alphaSamples":6400,"worldAnchor":"PASS","missingAssetFallback":"PASS","normalRenderer":"PASS"}
```

The alpha comparison exercises translated drawing, clipping, gradients,
destination-out, restore and transform reset on the original and dense visual
plates. It checks that the new detail layer preserves the original covered pixels.
Negative-coordinate floor samples agree with their wrapped texture coordinates.
A deliberately missing wall asset keeps the complete original material set active.

The existing prop-light-response regression passed all eight subtests, including
live workstation heat/progress, context recovery and bounded cache behavior.
All touched JavaScript passed `node --check`; `git diff --check` was clean.
The generated website mirror matched all 4,592 frontend files plus two embed files.

## Scope

No provider credentials were copied into this preview, and no model reply was
claimed as verified. No installed-desktop rebuild, release, publication or trunk
merge was performed. The material edition pins surface painting to the supplied
reference style; the existing material/color picker does not restyle that edition.
Other prop families, character artwork, and high-resolution side/corner sampling
are outside this first pass.
