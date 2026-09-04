# Cursor MCP setup (PropLane)

> **Superseded by [`agent-mcp-setup.md`](agent-mcp-setup.md) (PRP-182).** MCP is
> no longer Cursor-only — the server list is shared by Claude Code, Cursor and
> Codex, and `npm run check:mcp` enforces it. Read that file first; what remains
> below is the Cursor-specific enablement detail.


MCP servers help agents **test and debug** during phases ③–④. They do **not**
replace Linear tickets — use `LINEAR_API_KEY` + `npm run linear:ticket` instead.

Config file: **`.cursor/mcp.json`** (checked into the repo).

## Enable in Cursor

1. **Cursor → Settings → Tools & MCP**
2. Toggle each server **on**
3. **Supabase:** click Connect and sign in (dev project `emstjswhotsnyksqhqyf` only)
4. **chrome-devtools:** requires Chrome with remote debugging (see browser-use doctor)
5. Restart Cursor if a server stays red

Verify in terminal:

```bash
cursor agent mcp list
# playwright: ready
# browser-use: ready
# chrome-devtools: ready
# supabase: ready (after auth)
```

## Server guide

| MCP | When agents use it | Sandbox origins |
| --- | --- | --- |
| **playwright** | Automated clicks, form fills, smoke paths | localhost:3000–3014, prop-lane.space |
| **browser-use** | Captain-style manual QA, screenshots, multi-step flows | Captain's Chrome session |
| **chrome-devtools** | Inspect DOM, network, console on localhost | Auto-connect Chrome |
| **supabase** | Read/write **dev** schema, RLS checks | `emstjswhotsnyksqhqyf` |
| **linear** | Legacy — **prefer API scripts** | — |

## Linear: API not MCP

Tickets, triage, and plan linking use GraphQL:

```bash
# .env.local
LINEAR_API_KEY=lin_api_…

npm run linear:ticket -- --chat "…"
npm run linear:triage
npm run workflow:plan -- --chat "…"
```

See `docs/share/proplane-collaborator-workflow.md`.

## Troubleshooting

| Problem | Fix |
| --- | --- |
| MCP red / disconnected | Toggle off/on; **Output → MCP Logs** |
| Supabase `needsAuth` | Connect in MCP settings |
| Playwright can't reach :3011 | `npm run dev -- -p 3011` in cursor-2 worktree |
| browser-use can't attach | `browser-use --doctor`; enable Chrome remote debugging |
| Wrong database | Never point MCP or `.env` at production |

## PostHog verify (optional)

```bash
POSTHOG_PERSONAL_API_KEY=phx_… npm run posthog:verify
```

Dashboard: https://us.posthog.com/project/492655/dashboard/1952875
