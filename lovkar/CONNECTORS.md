# Connectors — what NOVA can reach, and what it deliberately cannot

## What it has today

Claude Code's own tools, scoped by the runner: `Read`, `Glob`, `Grep`, and `Write`/`Edit`
restricted by permission rule to `vault/**`. Plus the markdown vault, including **pinned**
notes that ride in every prompt.

That is a deliberately small surface. Everything below is about widening it.

## stdio MCP servers: blocked by StarNet's own sandbox policy

A stdio connector spawns a local process, so `handleConnectorUpsert` refuses one unless the
owning agent is on the **Safe Cell** execution profile with the **Docker** backend:

```
SAFE_CELL_REQUIRED: agent "<id>" must use the Safe Cell execution profile
                    before it can own a stdio MCP server
```

This machine reports `backend: local`, `sandboxFallback: refuse`, and has no Docker. So
`windows-mcp` and `Roblox_Studio` cannot be attached as they stand.

That is not a bug to route around. A stdio MCP server is an arbitrary local process handed
to an agent; requiring a container first is the correct call, and it is the same instinct
that put a fence around the vault. Enabling it means installing Docker Desktop and creating
a safe-cell agent — a real piece of work, and a deliberate one.

## Account connectors: not mine to copy

The Commander's other tools — the home server shell, Gmail, Spotify, 3D AI Studio, Blender,
Revolut X — authenticate to **his Claude account**, not to a local config file. Their
credentials live server-side.

Copying an auth token out of one application's account and into another application's
config is exactly the move that turns one compromised agent into a compromised everything.
It will not be done here, and there is a better path anyway: StarNet ships its own OAuth 2.1
client and a curated connector catalog (`sidecar/mcp/oauth.js`, `catalog.js`). Connecting a
service from StarNet's own Settings mints a **separate grant**, visible in a separate place
and revocable on its own, without touching the Commander's Claude account.

So: those are one screen and one sign-in away, and the sign-in is the Commander's to give.

## Not to be wired to an unattended agent

Three things compound here, and they are all true at once:

1. NOVA is set to **full power** — no approval prompts.
2. The vault is an **injection surface by construction**: one run writes, the next reads.
   That is why the fence and `lovkar/test-vault.js` exist.
3. Several of these connectors take **irreversible** actions.

Given all three, some doors stay shut regardless of what is technically possible:

| | |
| --- | --- |
| **Revolut X** | Never. It executes financial trades. An autonomous agent with no approval gate and a writable memory does not get a trading API — not scoped, not read-only-ish, not "just to try". |
| **Gmail send** | Not to a full-power agent. Sending mail as someone is not undoable. |
| **Shell on the PC or the home server** | Only with the approval gate ON, or from inside a Safe Cell. Both, ideally. |

Read-only reach — search, fetch, catalogues, status — is a different category and is fine.

## The mechanism that makes this workable

StarNet already scopes connectors physically: `toolDefsForObjects(objects)` projects a
connector's tools only into agents whose room has that connector **object placed on the
floor**. Connecting a service does not hand it to every agent; placing the object does.

So the sane shape is: connect the read-only services, place their objects in the rooms that
need them, and leave the irreversible ones out of the station entirely.
