# Faza 1 — runner in pot do postaje ✅

**14. 9. 2026** · veja `lovkar/claude-code-runner` · commita `e4c8619`, `ed72e90`

---

## Kaj zdaj deluje

```
POST /api/lovkar/run   { agentId, prompt, allowedTools?, model?, cwd? }
```

Požene pravi Claude Code run **na naročnini**, vrne NDJSON toka dogodkov klicatelju in
hkrati vsak dogodek pošlje na `chanEmit` — isti trajni SSE bus, ki ga posluša postaja.

Preverjeno v živo skozi pravo HTTP pot:

```
notify               ⚠ subscription 5h 4% · 7d 78%
agent.run.start      claude-opus-5[1m] / directive
agent.tool_call      Grep  {"pattern":"(?i)sidecar", "path":"…CODE_MAP.md", …}
agent.tool_result    ok  435ms
agent.cost           in=7585 out=223 cached=40273 think=0
agent.run.end        done  turns=2  usd=0.1025385
```

> "The sidecar is the harness: a single Node process (`sidecar/index.js`) that runs the
> agent loop, serves `frontend/`, and streams `U.bus` events to the browser over HTTP and
> SSE on port 8787."

In — ključno — naročnina na `/api/channels/events` med runom pokaže **iste dogodke na
busu postaje**: `agent.run.start`, `agent.tool_call`, `agent.tool_result`, `agent.cost`,
`agent.run.end`, `notify`. Frontend ni bil spremenjen niti za vrstico.

## Datoteke

| | |
|---|---|
| `sidecar/runners/claudecode-translate.js` | PURE stream-json → shared/events.js |
| `sidecar/runners/claudecode-runner.js` | spawn + NDJSON plumbing |
| `sidecar/routes/lovkar-run.js` | HTTP pot, dvojni emit (bus + odgovor) |
| `lovkar/patch-index.js` | **celoten** poseg v index.js, 3 vrstice, idempotentno |
| `lovkar/test-translate.js` | vrata: 128 dogodkov iz fixtur, vsi veljavni |
| `lovkar/fixtures/` | pravi faza-0 dumpi |

`sidecar/index.js` ima **3 dodane vrstice** in nobene spremenjene. Rebase na upstream je
`node lovkar/patch-index.js`.

---

## Naučeno

### 1. Vsaka `/api/*` pot zahteva token

Prvi klic je vrnil `forbidden token`. StarNet generira ob vsakem zagonu naključen
64-znakovni `API_TOKEN` in ga zahteva v glavi `x-starnet-token` na **vsaki** api poti
(nekaj izjem, ki glave ne morejo nositi, npr. SSE, uporablja `?token=`). Njihov threat
model je resen in dobro zapisan: brani pred zlonamerno spletno stranjo, ki bi skozi
loopback vozila agenta. Naša pot to pravilno podeduje, ker gate teče pred routerjem.

### 2. Ista quoting past, tretjič

PowerShellov `Start-Process -ArgumentList @(...)` je razbil `-H "x-starnet-token: …"` na
dva argumenta, zato je šla glava prazna. Isti mehanizem kot v fazi 0.

**Runner sam je imun** — Node `spawn(cmd, argv)` ubeži argumente. Ranljive so samo
PowerShell pomagalke okrog njega. Pravilo: v PowerShellu direktna invokacija (`& curl.exe …`)
ali `.cmd` ovojnica, nikoli `Start-Process -ArgumentList @(…)`.

### 3. `--allowedTools` res ne omejuje — potrjeno

V zadnjem runu je bil `allowedTools: ['Read','Glob']`, Claude Code pa je poklical **Grep**.
Brez zavrnitve. Dokumentacija to pove (bralna orodja tečejo tudi brez vnosa), zdaj je
empirično potrjeno. Za fazo 2 to pomeni: capability gate mora uporabiti `--disallowedTools`
oziroma deny pravila; allow stran sama ne zaklene ničesar.

---

## ⚠ Naslednja stvar ni faza 2, ampak registry profil

Odprl sem postajo v brskalniku. Onboarding ima dva koraka: *Create your Overseer* →
**Connect a brain**. Drugi korak je **trda zapora** — brez izbranega providerja se do tal
postaje ne pride.

Na tem zaslonu so: STARNET (njihova naročnina), Grok *Sign in*, Kimi *Sign in*,
OpenAI *ChatGPT or API key*, Ollama *Free – local* … in **Anthropic: API key**.

Točno ta luknja je razlog za ta fork, in vidna je na prvem zaslonu aplikacije.

Zato se **faza 4 (registry profil + connect zaslon) premakne pred fazo 2**. Vrstni red je
zdaj: profil `claude-code` z `keyRequired: false` in `unmetered: true` po vzoru `codex` →
ploščica *Sign in* na Connect a brain → šele potem orodja prek MCP. Brez tega postaje
sploh ne moreva videti animirane, z njim pa je fork takoj uporaben.

---

## Kako pognati

```powershell
cd D:\Claude\starnet-lovkar
node sidecar\index.js          # postaja na http://127.0.0.1:8787
node lovkar\test-translate.js lovkar\fixtures\faza0-spike1.jsonl lovkar\fixtures\faza0-spike2.jsonl
node lovkar\try-runner.js "tvoj prompt"
```
