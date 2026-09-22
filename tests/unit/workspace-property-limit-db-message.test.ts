// PLAN-0921-1648 (captain add-on Sep 22): `POST /api/property-records` turns the
// workspace record cap into `code: "property_record_limit"` so the listing
// editor can offer "Upgrade plan" / "Manage drafts" instead of a dead "Try
// again". Postgres hands that route nothing narrower than a `23514` and the
// trigger's own sentence, so the match is on words — and words drift. This
// pins the migrations' raise text to the one constant the route matches on: a
// reword now fails here rather than silently demoting the dialog.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  WORKSPACE_PROPERTY_LIMIT,
  WORKSPACE_PROPERTY_LIMIT_DB_MESSAGE,
  isWorkspacePropertyLimitDbMessage,
} from "@/lib/workspaces/types";

/** Every migration that raises the `enforce_property_workspace` record cap. */
const MIGRATIONS = [
  "supabase/migrations/20260911230000_portal_workspaces.sql",
  "supabase/migrations/20260921000000_workspace_ownership_transfer.sql",
];

function raiseLines(file: string): string[] {
  const sql = readFileSync(join(process.cwd(), file), "utf8");
  return sql
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("raise exception") && line.includes("workspace has reached"));
}

describe("the workspace record-cap raise text the API keys on", () => {
  for (const file of MIGRATIONS) {
    it(`${file} still raises a message the route recognises`, () => {
      const lines = raiseLines(file);
      expect(lines.length, "the record-cap raise is still there").toBeGreaterThan(0);
      for (const line of lines) {
        expect(isWorkspacePropertyLimitDbMessage(line), `"${line}" no longer contains "${WORKSPACE_PROPERTY_LIMIT_DB_MESSAGE}"`).toBe(true);
        // The sentence the manager reads names the same ceiling the dialog's
        // "N of 10" row falls back to.
        expect(line.includes(String(WORKSPACE_PROPERTY_LIMIT))).toBe(true);
      }
    });
  }

  it("does not mistake another 23514 for the record cap", () => {
    expect(isWorkspacePropertyLimitDbMessage("Assigned room no longer exists.")).toBe(false);
    expect(isWorkspacePropertyLimitDbMessage(null)).toBe(false);
  });
});
