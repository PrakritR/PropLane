/**
 * The kind → module mapping exists twice, and the copies must never drift.
 *
 * `REMINDER_SUBJECT_CO_MANAGER_MODULE` in
 * `src/lib/co-manager-notification-recipients.server.ts` is the source of
 * truth, but that module is `server-only` (it queries the database), so the
 * browser-rendered Notifications hub cannot import it and keeps a pure-data
 * mirror, `REMINDER_KIND_MODULE`.
 *
 * A comment asking the next person to keep two tables in sync is not a
 * guarantee; this is. Neither file can be imported side by side — one is
 * `server-only`, the other is a client component — so both mappings are parsed
 * out of the source text instead.
 *
 * If this fails, do not "fix" it by editing whichever side is red. Decide which
 * module the kind genuinely belongs to, change the SERVER file first, then
 * mirror it. The server mapping decides who actually gets notified; the client
 * one only decides which heading a row is drawn under, so a silent divergence
 * shows a manager a setting filed under one area while the notification is
 * authorized against another.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SERVER_FILE = "src/lib/co-manager-notification-recipients.server.ts";
const CLIENT_FILE = "src/components/portal/pro-portal-automation-settings-panel.tsx";

/** Pull `key: "value",` pairs out of the named object literal, ignoring comments. */
function parseMapping(relativePath: string, constName: string): Record<string, string> {
  const source = readFileSync(join(process.cwd(), relativePath), "utf8");
  const start = source.indexOf(`${constName}: Record<`);
  expect(start, `${constName} not found in ${relativePath}`).toBeGreaterThan(-1);
  const open = source.indexOf("{", start);
  const close = source.indexOf("\n};", open);
  expect(close, `could not find the end of ${constName} in ${relativePath}`).toBeGreaterThan(open);

  const body = source
    .slice(open + 1, close)
    // Strip block and line comments so prose inside the literal is never parsed
    // as an entry.
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

  const out: Record<string, string> = {};
  for (const match of body.matchAll(/(\w+)\s*:\s*"([^"]+)"/g)) {
    out[match[1]!] = match[2]!;
  }
  return out;
}

describe("reminder kind → module mapping parity", () => {
  it("the client mirror matches the server source of truth exactly", () => {
    const server = parseMapping(SERVER_FILE, "REMINDER_SUBJECT_CO_MANAGER_MODULE");
    const client = parseMapping(CLIENT_FILE, "REMINDER_KIND_MODULE");

    // Guard the parser itself: if a refactor breaks the extraction, both sides
    // would come back empty and trivially "match".
    expect(Object.keys(server).length).toBeGreaterThan(10);
    expect(client).toEqual(server);
  });

  it("covers every reminder kind the product defines", async () => {
    const { REMINDER_SUBJECT_KINDS } = await import("@/lib/reminders/rules");
    const client = parseMapping(CLIENT_FILE, "REMINDER_KIND_MODULE");
    // A kind with no module would be silently dropped from the hub's matrix
    // rather than rendered under a heading, so the manager would never see it.
    for (const kind of REMINDER_SUBJECT_KINDS) {
      expect(Object.keys(client), `reminder kind "${kind}" has no module`).toContain(kind);
    }
  });
});
