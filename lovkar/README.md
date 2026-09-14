# starnet-lovkar

A fork of [androoAGI/starnet](https://github.com/androoAGI/starnet) that runs on a **Claude
subscription** instead of a pay-as-you-go API key.

Upstream already offers account sign-in for ChatGPT, Grok and Kimi. Anthropic is API-key
only. That is the hole this fork fills, and it is visible on the app's own first screen.

Everything here is additive and lives in new files. `sidecar/index.js` has exactly three
added lines, and they are generated rather than hand-edited (see below), so rebasing onto
upstream stays cheap.

## What works today

```
POST /api/lovkar/run   { agentId, prompt, allowedTools?, model?, cwd? }
```

Runs Claude Code headless on your subscription, streams the run back to the caller as
NDJSON, and mirrors every event onto `chanEmit` — the same durable SSE bus the station
listens to. `frontend/` is untouched.

| file | role |
| --- | --- |
| `sidecar/runners/claudecode-translate.js` | PURE `stream-json` → `shared/events.js` |
| `sidecar/runners/claudecode-runner.js` | spawn + NDJSON plumbing |
| `sidecar/routes/lovkar-run.js` | the HTTP route, dual-emit (bus + response) |
| `lovkar/patch-index.js` | the **entire** `index.js` footprint, anchored and idempotent |
| `lovkar/test-translate.js` | the gate: every event validated against the frozen contract |
| `lovkar/scrub-fixture.js` | strips the home path out of a dump before it is committed |
| `lovkar/fixtures/` | real dumps, scrubbed |

## Run it

```bash
npm install
node lovkar/patch-index.js                    # apply the three index.js lines
node sidecar/index.js                         # station on http://127.0.0.1:8787
node lovkar/test-translate.js lovkar/fixtures/*.jsonl
node lovkar/try-runner.js "your prompt"       # live, no browser needed
```

Requires the Claude Code CLI, logged in with a Pro/Max/Team/Enterprise account
(`claude`, then the browser flow). No API key, and no `claude setup-token` on a machine
where you can log in interactively — `claude -p` inherits the stored credentials.

Every `/api/*` route needs the per-launch `x-starnet-token` header. The page carries it as
`window.__STARNET_API_TOKEN__`; SSE uses `?token=` instead.

## Design: why a runner and not a provider

`sidecar/providers/provider.js` is a transport seam — one model turn at a time, with the
harness executing tools between turns. Claude Code is not a completions endpoint; it owns
its own agent loop and its own tools. Two loops fight.

So Claude Code slots in one level up: it drives the turn, and we translate its output into
the events the station already renders. The pure translator is the whole contract, and it
is tested against real dumps rather than mocks.

## Next: the connect screen

Reaching the station floor at all requires picking a provider on *Connect a brain*, and the
tiles there are static markup in `frontend/index.html` keyed by `data-prov`, not generated
from `providers/registry.js`. A `claude-code` tile therefore needs three things, and the
order matters:

1. a `claude-code` profile in `providers/registry.js`
   (`keyRequired: false`, `unmetered: true`, modelled on the existing `codex` profile)
2. a branch in `runOnce` that routes that provider id to the runner **instead of**
   `selectProvider` — adding a `claude-code` case to `providers/factory.js` would be wrong,
   because there is no adapter satisfying the provider seam and never will be
3. the tile itself, plus the sign-in copy on the card

Step 2 is the real work and the only invasive one; it belongs in `lovkar/patch-index.js`
alongside the existing three insertions so the whole upstream footprint stays in one
reviewable, re-runnable script.

## Known, verified

- `--bare` does **not** read subscription OAuth credentials. Never use it here.
- `--allowedTools` pre-approves; it does not restrict. A run with
  `allowedTools: ['Read','Glob']` still called `Grep`. Capability gating will need the deny
  side.
- Thinking blocks carry a `signature`. The frozen event contract has nowhere to put one, so
  only `agent.reasoning` on/off is emitted for now.
- `rate_limit_event` reports live utilization of both the 5-hour and 7-day windows. It
  rides `notify` until a typed event and a proper gauge land — that is the honest
  replacement for a USD ledger on a subscription run.

## Licence

MIT, inherited from upstream. See `LICENSE` and `NOTICE.md`.
