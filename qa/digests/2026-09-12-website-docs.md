# Website and documentation reorganization

Lane: `agent/website-docs-0912`, based on integration `a7ae9f23e`.
Implementation: `df77a1426` and `626e4798c`.

The public website had 24 documentation pages under broad, overlapping navigation buckets,
an exhaustive card directory, and 15 equally weighted homepage features. This lane gives each
article one topic, differentiates guides from reference, and replaces the directory and guide
library with explicit entry paths. Existing page URLs remain available.

The six topics are Start here, Station & agents, Conveyor workflows, Repeat & automate,
Connect your tools, and Troubleshooting & help. The manifest in `scripts/website-shell.mjs`
owns navigation, article titles, the topic directory, section search index, and within-topic
pagers. Run that script after changing documentation content; `--check` detects drift.

Docs use plain reading type, higher contrast, native collapsible topic groups, and a responsive
sidebar. Illustrations retain the station's pixel style. Search indexes local article sections
and links to their anchors, supports keyboard navigation and an explicit empty state, and makes
no network requests. Article anchors are present in the static HTML. A broken existing
`somethings-not-running` help link now has a compatibility anchor.

The homepage has six feature summaries and three documentation paths. Its blocking boot overlay
is removed. First-run and installation copy follows the current two-step Overseer setup in
`frontend/app/overseer-setup.js`. The public version fallback is 0.11.2, verified against
[the public release](https://github.com/androoAGI/starnet-releases/releases/tag/v0.11.2).
Raw release labels are generated from the same fallback used by `website/site.js`.

## Observed browser behavior

- All 24 source docs pages checked at 390, 768, and 1440 CSS-pixel viewport widths: no document
  horizontal overflow; one main heading per page. Mobile illustrations had no broken image loads.
- Mobile menu opened; Conveyor workflows expanded; selecting Build your first workflow opened
  the nested guide with the menu reset to its closed state.
- Searching `Gatekeeper`, pressing ArrowDown, then Enter opened
  `docs/getting-started.html#macos-first-run` with the section positioned below the header.
- Unknown search displayed an explicit empty state; Escape closed results; a code-copy button
  reported Copied. The guide library exposed all nine walkthroughs.
- A direct link to `docs/index.html#automation` opened the correct topic. Reloading the updated
  quickstart at `#connect-a-provider` positioned its heading at 100 CSS pixels.
- The staged docs were served with `script-src 'none'`: article content and native topic expansion
  still worked; inactive search controls were hidden.
- Staged homepage showed 0.11.2, six features, three docs routes, and the rendered station iframe
  with two canvases. Source-only `website/` lacks the generated `app/embed.htm`, so the deliverable
  preview serves `website-deploy/` instead.

## Checks

- Syntax checks: all modified JS/MJS files passed; `git diff --check` passed.
- Shell regeneration: 31 pages, 0 would change, 24 indexed.
- Documentation navigation: 1,347 assertions, including 1,103 internal page links, passed after
  the final quickstart edit.
- Initial website slice: five suites passed (pricing hold, docs navigation, deploy staging,
  app synchronization, and live preview), 1,406 assertions before the final copy refinement.
- Final copy refinement: navigation 1,347 and deploy staging 25 assertions rechecked green;
  the other three website suites are unchanged. All 36 modified publishable website files
  in the staging directory were byte-compared with committed source; zero mismatches.
- Full gate: **NOT GREEN / INCOMPLETE**. The Node 24 `npm run test:fast` run hit its
  900,000 ms watchdog on this shared host before finishing all 772 manifest steps.
  Its log reports `[timeout] test:fast exceeded 900000ms; terminating process tree.`
  This is not an assertion-failure-free full-suite receipt and does not permit integration.
  Raw log: `.dogfood/fast-node24.log`. The fresh worktree initially lacked `ogg-opus-decoder`;
  `npm ci --ignore-scripts` installed the locked dependencies. Node 22.23.0 then produced varying
  failures in unchanged `voice.button.test.js`. Its standalone Node 24.19.0 run passed 140/140,
  and the full Node 24 rerun passed that suite as well. No voice source or tests were changed.

The local deliverable preview is `http://127.0.0.1:8925/docs/`, served from the isolated
worktree's staging directory by the owned `.dogfood/preview.py` helper (PID 42396 at launch).
The earlier source-only server on 8924 was stopped. Preview tabs unrelated to the deliverable
were closed and viewport overrides reset.

No integration merge or publication was performed. This is website behavior verification;
it does not certify every pre-existing documentation claim or the installed desktop product.
