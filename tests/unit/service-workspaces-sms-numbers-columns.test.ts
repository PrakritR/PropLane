// Admin › Service 503'd because the list selected `manager_sms_numbers.created_at`, a column that table never had
// (the in-memory fake database accepts any column). This pins every column the service code selects from
// `manager_sms_numbers` to a column the migrations actually create.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function realColumns(table: string): Set<string> {
  const cols = new Set<string>();
  const dir = join(root, "supabase/migrations");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql"))) {
    const sql = readFileSync(join(dir, file), "utf8").replace(/--.*$/gm, "");
    const create = new RegExp(`create table (?:if not exists )?(?:public\\.)?${table}\\s*\\(([\\s\\S]*?)\\n\\);`, "i").exec(sql);
    if (create) {
      for (const line of create[1]!.split("\n")) {
        const m = /^\s*([a-z_][a-z0-9_]*)\s+(?:uuid|text|integer|int|bigint|boolean|timestamptz|jsonb|numeric|date)\b/i.exec(line);
        if (m) cols.add(m[1]!.toLowerCase());
      }
    }
    for (const m of sql.matchAll(new RegExp(`alter table (?:public\\.)?${table}\\s+add column (?:if not exists )?([a-z_][a-z0-9_]*)`, "gi"))) cols.add(m[1]!.toLowerCase());
  }
  return cols;
}

describe("manager_sms_numbers selects in the service workspace list", () => {
  it("only name columns the table has", () => {
    const real = realColumns("manager_sms_numbers");
    expect(real.has("phone_number") && real.has("requested_at") && real.has("workspace_id")).toBe(true);
    expect(real.has("created_at")).toBe(false);
    const src = readFileSync(join(root, "src/lib/service/service-workspaces.server.ts"), "utf8");
    const selects = [...src.matchAll(/\.from\("manager_sms_numbers"\)\s*\.select\("([^"]+)"/g)].map((m) => m[1]!);
    expect(selects.length).toBeGreaterThan(0);
    for (const sel of selects) {
      for (const col of sel.split(",").map((c) => c.trim())) expect(real, `unknown column ${col}`).toContain(col);
    }
    expect(src).not.toMatch(/old\.created_at/);
  });
});
