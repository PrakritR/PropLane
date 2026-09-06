# Cursor + Chrome DevTools MCP

Connect Cursor to a live Chrome instance so the agent can capture screenshots, inspect
the DOM, read console logs, and trace network requests while you exercise PropLane locally.

Official package: [ChromeDevTools/chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp)

This repo also ships **Playwright MCP** in `.cursor/mcp.json` for scripted Chromium
automation. Use **Chrome DevTools MCP** when you want the agent to see the same
logged-in session you have open in Chrome (manager portal on localhost, staging preview,
etc.).

## Fastest setup (Cursor does the wiring)

1. Open **Cursor Chat** and paste:

   > Install the Chrome DevTools MCP and enable it for me.

2. Cursor should add the server under **Settings → MCP**. If it asks, point it at
   `npx -y chrome-devtools-mcp@latest`.

3. **macOS:** grant **Full Disk Access** to Cursor  
   **System Settings → Privacy & Security → Full Disk Access → Cursor** (on).

4. Restart Cursor, then reload the MCP server list.

## Repo config (already checked in)

`.cursor/mcp.json` includes a `chrome-devtools` entry alongside Supabase and
Playwright. After pulling, open **Cursor Settings → MCP** and confirm
`chrome-devtools` is enabled (green).

Manual block if you need to paste it yourself:

```json
"chrome-devtools": {
  "command": "npx",
  "args": ["-y", "chrome-devtools-mcp@latest"]
}
```

## Using your existing Chrome tab

By default the MCP server can launch its own Chrome profile. To attach to a Chrome
window you already have open (same cookies / signed-in portal):

1. Quit Chrome completely, then start it with remote debugging:

   ```bash
   /Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
     --remote-debugging-port=9222 \
     --user-data-dir=/tmp/chrome-profile-proplane
   ```

2. Open the tab you want (e.g. `http://localhost:3010/portal` on the `cursor-1`
   worktree, or `http://localhost:3000` on integration).

3. Optional: add `"--browser-url=http://127.0.0.1:9222"` to the `args` array in
   `.cursor/mcp.json` under `chrome-devtools`, then restart the MCP server.

4. Open DevTools on that tab if you want the same view the MCP tools use
   (**View → Developer → Developer Tools**, or right-click → **Inspect**).

## PropLane URLs agents should use

| Worktree / branch | Local URL |
| --- | --- |
| `cursor-1` keeper (this pane) | `http://localhost:3010` |
| `prakrit` integration | `http://localhost:3000` |
| Deployed QA | See [staging custom domain](database-environments.md#staging-custom-domain-namecheap--vercel) |
| Production | `https://prop-lane.space` (read-only debugging only) |

Prefer **`/portal`** with a seeded test manager (`manager@test.proplane.local` after
`npm run test:seed`) for ship-gate feature walks — not `/demo` alone. See
[`tests/README.md`](../tests/README.md) and [`docs/ship-gate.md`](ship-gate.md).

## Example agent prompts

**UI layout / spacing**

> Open `http://localhost:3010/portal/properties`, take a screenshot at mobile width,
> and list any controls that overlap or have less than 12px vertical gap.

**Console errors after a change**

> Navigate to the lease editor modal on localhost:3010, open Edit lease, and report
> any console errors or failed network requests.

**Happy-path walkthrough**

> Signed in as manager on localhost:3010, walk Properties → open a lease → Save, and
> confirm no 4xx/5xx on `/api/property-records`.

## Browser Use (Cursor Marketplace plugin)

The **Browser Use** plugin spawns `uvx browser-use@latest --cli-mcp`. That requires
**[uv](https://docs.astral.sh/uv/)** (`uvx` on your PATH). If MCP logs show
`spawn uvx ENOENT`, install uv once:

```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
```

Then ensure Cursor can find it (either restart Cursor after install, or symlink into
Homebrew’s bin, which GUI apps usually inherit):

```bash
ln -sf ~/.local/bin/uvx /opt/homebrew/bin/uvx
ln -sf ~/.local/bin/uv /opt/homebrew/bin/uv
```

In **Customize → MCPs**, toggle **browser-use** off and on (or restart Cursor) until
the server shows connected. Optional: in Chrome open
`chrome://inspect/#remote-debugging` and enable remote debugging if the plugin asks
for an attached browser.

PropLane URLs are the same as the table below (`http://localhost:3010` for this
worktree).

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `spawn uvx ENOENT` (Browser Use) | Install uv (see **Browser Use** above); symlink to `/opt/homebrew/bin`; restart MCP |
| MCP server won't start | Node 20+ required; run `npx -y chrome-devtools-mcp@latest --help` in a terminal |
| Tools missing in chat | Cursor **Customize → MCPs** → enable the server; restart Cursor |
| Wrong browser / no login | Use `--browser-url` attach flow above, or sign in inside the MCP-launched profile |
| macOS permission errors | Full Disk Access for Cursor (see above) |

## Related

- Playwright E2E: `npm run test:e2e` — [`tests/README.md`](../tests/README.md)
- Ship-gate manual testing: [`docs/ship-gate.md`](ship-gate.md)
- Database MCP note: [`docs/database-environments.md`](database-environments.md#a-note-on-mcp)
