# Faza 0 — preslikava dogodkov ✅

**Dokončano:** 14. 9. 2026 · Claude Code **2.1.270** · model `claude-opus-5`
**Surovi dumpi:** `D:\Claude\starnet-spike\spike1.jsonl` (171 vrstic), `spike2.jsonl` (30 vrstic)

Cilj faze 0 je bil dokazati, da veriga stoji, in dobiti tabelo preslikav. Oboje je narejeno.

---

## Ukaz, ki dela

```
claude -p "<prompt>" --output-format stream-json --verbose --include-partial-messages
       --allowedTools Read --permission-mode dontAsk --permission-prompts none
```

cwd = korenina repozitorija. Brez `--bare` (ta ne bere naročniških credentialov).
Rezultat testa: 30 vrstic, 2 turna, 3,6 s, en klic orodja, pravilen odgovor.

---

## Tabela preslikav

| Claude Code stream-json | → StarNet HarnessEvent | opomba |
|---|---|---|
| `content_block_start` (`text`) | — | samo odpre blok |
| `content_block_delta` / `text_delta` → `.delta.text` | `{type:'text', delta}` | 1:1 |
| `content_block_start` (`tool_use`) → `index`, `.content_block.id`, `.content_block.name` | `{type:'tool_start', index, id, name}` | **imena polj se ujemajo dobesedno** |
| `content_block_delta` / `input_json_delta` → `index`, `.delta.partial_json` | `{type:'tool_args', index, chunk}` | argumenti kot string fragmenti — točno to, kar `loop.js` akumulira po indeksu |
| `content_block_stop` → `index` | `{type:'tool_done', index}` | 1:1 |
| `content_block_start` (`thinking`) + `thinking_delta` + `signature_delta` | `{type:'reasoning', block}` | blok MORA nositi `signature` |
| `message_delta` → `.delta.stop_reason` | `{type:'done', finishReason}` | `tool_use`→`tool_calls`, `end_turn`→`stop` |
| `message_delta.usage`, `result.usage` | `{type:'usage', usage}` | input / output / cache_read / cache_creation / thinking_tokens |
| `result` | konec runa | `num_turns`, `duration_ms`, `ttft_ms`, `total_cost_usd`, `permission_denials` |
| `rate_limit_event` | **nov instrument** | glej §Najdba 1 |
| `system` / `init` | metapodatki seje | `session_id`, `model`, `tools`, `mcp_servers`, `cwd`, `permissionMode` |
| `user` | rezultat orodja | |

---

## Najdba 1 — `rate_limit_event` je boljši, kot smo upali

Načrt je predvideval, da bomo porabo limita razbirali iz `api_retry` dogodkov. Ni treba.
Claude Code oddaja prvorazreden dogodek z živimi podatki:

```json
{"type":"rate_limit_event","rate_limit_info":{
  "status":"allowed_warning","rateLimitType":"seven_day",
  "utilization":0.78,"surpassedThreshold":0.75,"isUsingOverage":false,
  "unifiedWindows":{
    "five_hour":{"utilization":0.03,"resetsAt":1789422000},
    "seven_day":{"utilization":0.78,"resetsAt":1789596000}}}}
```

**Posledica za UI:** merilnik na postaji, ki zdaj kaže USD, lahko kaže **dejansko porabo
naročnine v obeh oknih, v živo, z odštevanjem do resetа.** To je boljši instrument od
števca dolarjev — dolar je pri naročnini itak izmišljen.

---

## Najdba 2 — `normalizeFinish()` že govori ta jezik

`providers/provider.js` že preslikuje `tool_use → tool_calls` in `end_turn → stop`.
Za razloge zaključka ni treba napisati niti vrstice. Njihov komentar v `loop.js` pravi
"Claude Code shape" — in to ni bila metafora.

## Najdba 3 — thinking bloki nosijo `signature`

`{"type":"thinking","thinking":"","signature":""}`, polnjen prek `thinking_delta` in
`signature_delta`. Njihov provider kontrakt izrecno opozarja, da je treba podpisane bloke
predvajati dobesedno ob tool_calls istega turna. Ujema se — `reasoning` ostane opaque.

## Najdba 4 — Windows quoting past (potrjena na prvem poskusu)

Prvi spike je padel: PowerShellov `Start-Process -ArgumentList @(...)` stakne polje s
presledki **brez narekovajev**, zato je `-p` pojedel samo prvo besedo prompta. Run je
vseeno uspel in vrnil veljaven stream — tiha napaka, najslabša vrsta.

**Popravek:** en sam dobesedni niz z eksplicitnimi narekovaji. V runnerju bo to Nodeov
`child_process.spawn(cmd, argsArray)`, ki argumente ubeži pravilno — to past ima samo
PowerShell.

## Najdba 5 — strošek se poroča tudi na naročnini

`total_cost_usd` je prisoten (npr. 0,1999645 za prvi run). Po dokumentaciji je to ocena
na strani odjemalca. Torej ledger ni nujno $0 — lahko kaže "toliko bi to stalo prek API-ja",
kar je lep kontrast ob merilniku porabe naročnine.

## Najdba 6 — `caller` polje

`content_block_start` za tool_use nosi `"caller":{"type":"direct"}`. Skupaj s
`parent_tool_use_id` na sporočilih to loči glavnega agenta od podagentov — natanko tisto,
kar postaja rabi, da ve, kdo od posadke se premakne.

---

## Odprto za fazo 2

`--allowedTools` po dokumentaciji **predodobri**, ne omejuje — bralna orodja tečejo tudi
brez vnosa. Če naj StarNetov capability gate dejansko omejuje, bo treba `--disallowedTools`
oziroma deny pravila. To rabi svoj test, preden se nanj zanesemo.

---

## Stanje limita ob testu

| okno | poraba | reset |
|---|---|---|
| 5-urno | 3 % | 14. 9. 2026 23:40 |
| **7-dnevno** | **78 %** | 17. 9. 2026 00:00 |

Sedemdnevno okno je čez opozorilni prag 0,75. Do srede zato brez velikih vzporednih runov —
kar je hkrati živ dokaz tveganja št. 1 iz načrta.
