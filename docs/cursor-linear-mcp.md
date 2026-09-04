# Cursor + Linear MCP

Connect Cursor to your Linear workspace so the agent can list issues, create tasks,
and pull project context without leaving the IDE.

Official docs: [Linear MCP server](https://linear.app/docs/mcp) ·
[Cursor integration](https://linear.app/integrations/cursor-mcp)

## Repo config (checked in)

`.cursor/mcp.json` includes a `linear` entry that proxies Linear's hosted MCP
through `mcp-remote` (Linear's recommended manual setup for Cursor).

After pulling:

1. Open **Cursor Settings → Tools & MCP** (or **Features → MCP** on older builds).
2. Confirm **`linear`** is enabled (green).
3. On first use, complete the **Linear OAuth** prompt in the browser.
4. Restart Cursor if the server stays red — remote MCP can need a second attempt.

## Manual block

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
