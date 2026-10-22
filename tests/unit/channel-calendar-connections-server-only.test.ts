/**
 * `external_calendar_connections` holds the import URL (a secret) and names the property the cron sync writes room
 * blocks onto, so a client that could write a row could aim its own iCal at another landlord's house. The table is
 * server-only: no module that ships to the browser may touch it, and the migration takes the client write grants away.
 */
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const TABLE = "external_calendar_connections";

function filesNamingTheTable(): string[] {
  const out = execSync(`git grep -l "${TABLE}" -- src`, { cwd: ROOT, encoding: "utf8" });
  return out.split("\n").map((f) => f.trim()).filter(Boolean);
}

describe("external_calendar_connections is never written from the client", () => {
  it("no 'use client' module names the table, and no source builds a browser Supabase client for it", () => {
    for (const file of filesNamingTheTable()) {
      const source = readFileSync(path.join(ROOT, file), "utf8");
      expect(/^\s*["']use client["']/m.test(source), `${file} is a client module`).toBe(false);
      expect(/supabase\/(browser|client)["']/.test(source), `${file} imports a browser Supabase client`).toBe(false);
    }
  });

  it("every write on the table sits behind a service-role route or a server module", () => {
    const writers = filesNamingTheTable().filter((file) => {
      const source = readFileSync(path.join(ROOT, file), "utf8");
      return new RegExp(`from\\("${TABLE}"\\)\\s*\\.(insert|update|upsert|delete)`).test(source);
    });
    // `export-fetch-stamp.ts` is a plain helper whose only caller is the public export route (service-role db).
    const serverHelpers = new Set(["src/lib/channel-calendar/export-fetch-stamp.ts"]);
    for (const file of writers) {
      expect(
        file.startsWith("src/app/api/") || file.endsWith(".server.ts") || serverHelpers.has(file),
        `${file} writes the table outside a server module`,
      ).toBe(true);
    }
  });

  it("the migration revokes client writes and leaves the owner a SELECT-only policy", () => {
    const sql = readFileSync(path.join(ROOT, "supabase/migrations/20261021090200_channel_calendar_connections_server_only.sql"), "utf8");
    expect(sql).toMatch(/revoke insert, update, delete on public\.external_calendar_connections from anon, authenticated/);
    expect(sql).toMatch(/drop policy if exists "external_calendar_connections_owner" on public\.external_calendar_connections/);
    expect(sql).toMatch(/for select/);
    expect(sql).not.toMatch(/for (all|insert|update|delete)/);
  });
});
