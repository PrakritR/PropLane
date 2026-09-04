# Cursor + Linear MCP

Connect Cursor to your Linear workspace so the agent can list issues, create tasks,
and pull project context without leaving the IDE.

**Ticket filing rules, labels, and workflow:** [`docs/linear-ticket-system.md`](linear-ticket-system.md)

Official docs: [Linear MCP server](https://linear.app/docs/mcp) ·
[Cursor integration](https://linear.app/integrations/cursor-mcp)

## Repo config (checked in)

`.cursor/mcp.json` includes a `linear` entry pointing at Linear's hosted MCP
(`https://mcp.linear.app/mcp`). Cursor authenticates via **OAuth** on first connect.

After pulling:

1. Open **Cursor Settings → Tools & MCP** (⌘⇧J).
2. Find **`linear`** under MCP servers and **enable** it.
3. Click the **pencil / Connect** control next to `linear` and sign in to Linear when prompted.
4. Restart Cursor if the status stays red.

## Manual block (native Cursor OAuth)

```json
"linear": {
  "type": "http",
  "url": "https://mcp.linear.app/mcp"
}
```

## Fallback: mcp-remote (older Cursor builds)

If OAuth never appears, use Linear's stdio proxy instead:

```json
"linear": {
  "command": "npx",
  "args": ["-y", "mcp-remote", "https://mcp.linear.app/mcp"]
}
```

## API key instead of OAuth (optional)

If OAuth does not complete, use a personal API key from
[linear.app/settings/api](https://linear.app/settings/api) and replace the block
above with:

```json
"linear": {
  "type": "http",
  "url": "https://mcp.linear.app/mcp",
  "headers": {
    "Authorization": "Bearer ${env:LINEAR_API_KEY}"
  }
}
```

Export `LINEAR_API_KEY` in your shell (or Cursor's environment) — **never**
commit the key. Read-only mode: use `https://mcp.linear.app/mcp/readonly`.

## Verify

In Composer, type `@` and look for **linear** tools (e.g. list issues). Or ask:

> List my open Linear issues assigned to me.

## Troubleshooting

- **Red / disconnected:** Toggle the server off and on; check **Output → MCP Logs**.
- **401 / 403:** Re-auth OAuth or regenerate the API key with the scopes you need.
- **WSL:** Linear documents an SSE fallback — see their MCP FAQ if Streamable HTTP fails.
