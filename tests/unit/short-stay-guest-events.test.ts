import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const MIGRATIONS = join(process.cwd(), "supabase/migrations");

/** The newest migration that (re)defines a check constraint wins, so read them in order. */
function latestCheckList(constraint: string): string[] {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  let list: string[] = [];
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS, file), "utf8");
    const re = new RegExp(`add constraint ${constraint}[\\s\\S]*?check\\s*\\(\\s*\\w+\\s+in\\s*\\(([\\s\\S]*?)\\)\\s*\\)`, "g");
    for (const match of sql.matchAll(re)) list = [...match[1]!.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
  }
  return list;
}

describe("the guest-stay action events fit the existing action_events checks", () => {
  it("channel_booking is an admitted domain and tours an admitted category, so no constraint needs widening", () => {
    expect(latestCheckList("action_events_domain_check")).toContain("channel_booking");
    expect(latestCheckList("action_events_category_check")).toContain("tours");
  });

  it("every event the guest-stay code emits uses exactly that domain and category", () => {
    const sources = [
      "src/lib/short-stay/hold-decisions.server.ts",
      "src/lib/short-stay-request.server.ts",
    ].map((file) => readFileSync(join(process.cwd(), file), "utf8")).join("\n");
    expect([...sources.matchAll(/domain: "([a-z_]+)"/g)].map((m) => m[1])).toEqual(["channel_booking", "channel_booking"]);
    expect([...sources.matchAll(/category: "([a-z_]+)"/g)].map((m) => m[1])).toEqual(["tours", "tours"]);
    for (const event of ["short_stay_confirmed", "short_stay_declined", "short_stay_expired", "short_stay_requested"]) {
      expect(sources).toContain(event);
    }
  });

  it("the new index is additive and idempotent", () => {
    const sql = readFileSync(join(MIGRATIONS, "20261014090000_guest_stays_resident_index.sql"), "utf8");
    expect(sql).toMatch(/create index if not exists portal_schedule_records_guest_stay_idx/);
    expect(sql).not.toMatch(/\b(drop|alter|delete|update)\b\s+(table|column|from)?/i);
  });
});
