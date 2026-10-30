import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import catalog from "../fixtures/recovery/dev-hook-catalog-20261030.json";
import KNOWN_RECOVERY_HOOK_GAPS from "../fixtures/recovery/known-hook-gaps.json";

/** The checked-in catalog is a point-in-time baseline. Set RECOVERY_HOOK_CATALOG to a
 * freshly captured catalog JSON to check a current database; the default is not a live probe. */
function observedCatalog(): Record<string, string> {
  const path = process.env.RECOVERY_HOOK_CATALOG;
  if (!path) return catalog;
  const raw = JSON.parse(readFileSync(path, "utf8")) as { rows: Array<{ tbl: string; triggers: Array<{ name: string; type: number; enabled: string; function: string }> }> };
  const manifest = readFileSync("src/lib/auth/account-purge-manifest.ts", "utf8");
  const tableNames = [...manifest.matchAll(/table:\s*"([a-z0-9_]+)"/g)].map((match) => match[1]);
  const snapshot: Record<string, string> = Object.fromEntries(tableNames.map((name) => [name, "missing_or_mismatch"]));
  for (const row of raw.rows) {
    if (!(row.tbl in snapshot)) continue;
    const matches = (name: string, type: number) => row.triggers.some((t) => t.name === name && t.type === type && t.enabled === "O" && t.function === `${name}()`);
    snapshot[row.tbl] = matches("account_recovery_write_guard", 31) && matches("account_recovery_capture_delete", 9) ? "both_signature_checked" : "missing_or_mismatch";
  }
  return snapshot;
}

/** Compare an observed catalog to explicit debt; a fix must remove its entry. */
function differences(observed: Record<string, string>, known: Record<string, { reason: string }>) {
  const missing = Object.keys(observed).filter((name) => observed[name] === "missing_or_mismatch").sort();
  const expected = Object.keys(known).sort();
  return { newGaps: missing.filter((name) => !expected.includes(name)), fixedDebt: expected.filter((name) => !missing.includes(name)) };
}
describe("recovery hook debt snapshot", () => {
  it("accounts for the reviewed catalog after the forms migration", () => {
    const migration = readFileSync("supabase/migrations/20261030144900_move_in_forms_recovery_guards.sql", "utf8");
    expect(migration).toContain("before insert or update or delete on public.resident_move_in_forms");
    expect(migration).toContain("after delete on public.resident_move_in_forms");
    const observed = observedCatalog();
    const projected = process.env.RECOVERY_HOOK_CATALOG ? observed : { ...observed, resident_move_in_forms: "both_signature_checked" };
    expect(differences(projected, KNOWN_RECOVERY_HOOK_GAPS)).toEqual({ newGaps: [], fixedDebt: [] });
    for (const entry of Object.values(KNOWN_RECOVERY_HOOK_GAPS)) expect(entry.reason.trim().length).toBeGreaterThan(20);
  });
  it("detects a newly missing hook and requires fixed debt to be removed", () => {
    expect(differences({ unexpected: "missing_or_mismatch", fixed: "both_signature_checked" }, { fixed: { reason: "review" } }))
      .toEqual({ newGaps: ["unexpected"], fixedDebt: ["fixed"] });
  });
});
