# Agent MCP setup — every host (PropLane)

MCP servers are how an agent **tests and debugs** during build and review. They
do **not** replace Linear tickets or the plan gate — see
[`share/proplane-collaborator-workflow.md`](share/proplane-collaborator-workflow.md).

## One list, three hosts

**`.mcp.json` at the repo root is canonical.** Cursor cannot be pointed at
another path, so `.cursor/mcp.json` is kept **byte-identical** to it and
`npm run check:mcp` enforces that. Edit the root file, then copy it across.

| Host | Reads | Setup |
| --- | --- | --- |
| **Claude Code** | `.mcp.json` (repo root) | Automatic — approve the servers when prompted |
| **Cursor** | `.cursor/mcp.json` | Settings → Tools & MCP → toggle each server on |
| **Codex** | `~/.codex/config.toml` (per machine) | Paste the block below — see [Codex](#codex) |

```bash
npm run check:mcp   # root and Cursor agree · dev project pinned · ports 3000-3014
```

### Why this is checked and not just documented

Before this, only Cursor had MCP. Which agent happened to pick up a ticket
silently decided whether it could drive a browser or query the dev database — a
Cursor lane would verify a fix in a real browser and a Claude Code lane on the
same ticket could not, with nothing in the ticket recording which had happened.

## The servers

| MCP | What agents use it for | Notes |
| --- | --- | --- |
| **supabase** | Inspect dev rows while debugging | **Dev project `emstjswhotsnyksqhqyf` only.** See below. |
| **playwright** | Automated clicks, form fills, smoke paths | Origins `3000-3014` + `prop-lane.space` |
| **chrome-devtools** | Live DOM, console, network on a running page | Needs Chrome with remote debugging |
| **browser-use** | Higher-level natural-language browser driving | Needs `uv` on PATH — see below |
| **linear** | Read and file tickets | Ticket **creation** in the pipeline uses `npm run linear:ticket` |

### Supabase: writes are enabled, on the dev project, deliberately

The URL carries `read_only=false`, which is a real capability, so it is spelled
out rather than left to be discovered:

- The `project_ref` is **`emstjswhotsnyksqhqyf`** — the shared **dev/test**
  project. Production is a **separate** project whose credentials live only in
  Vercel ([`database-environments.md`](database-environments.md)).
- Writes are enabled because seeding and repairing dev rows while debugging is
  the point of having it.
- **The standing rule is unchanged: nothing an agent runs may create or edit
  production data.** `check:mcp` fails if the ref is ever anything but the dev
  project, so this cannot drift into production by an edit nobody reviewed.

### browser-use needs `uv` on PATH

The server runs `uvx`. It previously hardcoded `/opt/homebrew/bin/uvx`, which is
Apple-silicon-specific — on any other machine the server simply never comes up,
with no error that names the cause. It now calls plain `uvx`, so install `uv`
and make sure it is on PATH:

```bash
brew install uv        # or: curl -LsSf https://astral.sh/uv/install.sh | sh
which uvx              # must print a path
```

### Playwright origins must match the sandbox ports

Each lane runs its own dev server, and the ports go up to **3014**. An origin
that is not allow-listed fails as a *permission error*, which reads like a
broken test rather than a config gap — that is exactly how the list silently
fell behind at 3011 while lanes were running on 3012 and above. `check:mcp`
asserts every port in `3000-3014` on both `localhost` and `127.0.0.1`.

### The app's own BACKENDS must be allow-listed, not just its ports

`ERR_BLOCKED_BY_CLIENT` on a request means **that origin is not in
`--allowed-origins`**. It never says so. The failure surfaces in the page as a
bare `TypeError: Failed to fetch` from whichever SDK made the call, which is
indistinguishable from a product defect.

That is not hypothetical. The list once held localhost ports only, so every call
to Supabase was refused — auth included. `signInWithPassword` failed silently,
so **no authenticated surface had ever actually been browser-tested**, and an
exhaustive portal audit filed a wall of "console error" and "session lost"
tickets against the manager, resident and vendor portals that were all this one
config gap (PRP-212; the audit tickets PRP-234…PRP-250 and PRP-298…PRP-305).
A signup ticket was even raised as Urgent — the account had been created by a
same-origin `/api/…` route, and only the cross-origin sign-in was blocked, so
the button spun forever.

So the list carries the backends the app actually talks to, and `check:mcp`
asserts them the way it asserts the port range:

```
https://*.supabase.co          auth + PostgREST
https://api.stripe.com         payment intents
https://js.stripe.com          Stripe.js
https://hooks.stripe.com       3DS / redirect flows
https://*.posthog.com          analytics (noisy if blocked, not fatal)
```

**Why not simply allow every origin for local QA?** Because the same browser
profile can reach production. An explicit list that is machine-checked keeps a
stray QA run from driving `prop-lane.space`'s live backends, and the cost of
keeping it current is one `check:mcp` failure with the missing origin named.
Add a backend here when the app starts calling one — do not switch the list off.

**Config changes need a host restart.** A running MCP server does not re-read
`.mcp.json`; until it is restarted the old list is still in force, which is its
own way of looking like an app bug.

## Codex

Codex reads a per-machine config, so it cannot be wired from the repo. Paste
this into `~/.codex/config.toml` (values mirror `.mcp.json`):

```toml
[mcp_servers.playwright]
command = "npx"
args = ["-y", "@playwright/mcp@latest", "--browser=chromium", "--caps=devtools"]

[mcp_servers.chrome-devtools]
command = "npx"
args = ["-y", "chrome-devtools-mcp@latest", "--autoConnect"]

[mcp_servers.browser-use]
command = "uvx"
args = ["--python", "3.12", "browser-use@latest", "--cli-mcp"]
```

The two HTTP servers (`supabase`, `linear`) are added through Codex's own
remote-MCP flow, since they authenticate interactively.

## Verify

```bash
npm run check:mcp          # config parity + safety assertions
cursor agent mcp list      # Cursor: each server "ready"
```

In Claude Code, `/mcp` lists the connected servers. If one stays red, restart
the host — several servers only connect at startup.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Playwright refuses a localhost URL | Port outside `3000-3014`; add it to `.mcp.json` **and** re-run `check:mcp` |
| `ERR_BLOCKED_BY_CLIENT` in the console | That **origin** is not allow-listed — not an app bug. Check the backend list above |
| `TypeError: Failed to fetch` from `@supabase/auth-js` | Same cause: the Supabase origin is blocked, or the host was not restarted after editing `.mcp.json` |
| Sign-in "hangs" with no error | Same cause. The account may well have been created by the same-origin API route |
| `browser-use` never starts | `uvx` not on PATH |
| chrome-devtools stays red | Chrome not running with remote debugging |
| supabase asks to sign in | Expected — it authenticates interactively per host |
| `check:mcp` says the files differ | Edit `.mcp.json`, then `cp .mcp.json .cursor/mcp.json` |
