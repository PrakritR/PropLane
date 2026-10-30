import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import catalog from "../fixtures/recovery/dev-hook-catalog-20261030.json";
import sourceDigest from "../fixtures/recovery/source-digest.json";
import KNOWN_RECOVERY_HOOK_GAPS from "../fixtures/recovery/known-hook-gaps.json";

/** The checked-in catalog is a point-in-time baseline. Set RECOVERY_HOOK_CATALOG to a
 * freshly captured catalog JSON to check a current database; the default is not a live probe. */
function observedCatalog(): Record<string, string> {
  const path = process.env.RECOVERY_HOOK_CATALOG;
  if (!path) return catalog;
  type Trigger = { name: string; type: number; enabled: string; function: string; function_oid: string; nargs: number; qual: string | null; constraint_oid: string; attributes: string; internal: boolean };
  const raw = JSON.parse(readFileSync(path, "utf8")) as { expected_functions?: Array<{ oid: string; name: string; signature: string; returns_trigger: boolean }>; rows: Array<{ tbl: string; relkind: string; triggers: Trigger[] }> };
  const manifest = readFileSync("src/lib/auth/account-purge-manifest.ts", "utf8");
  const tableNames = [...manifest.matchAll(/table:\s*"([a-z0-9_]+)"/g)].map((match) => match[1]);
  const snapshot: Record<string, string> = Object.fromEntries(tableNames.map((name) => [name, "absent"]));
  for (const row of raw.rows) {
    if (!(row.tbl in snapshot)) continue;
    const matches = (name: string, type: number) => {
      const candidates = raw.expected_functions?.filter((entry) => entry.name === name) ?? [];
      const expected = candidates.length === 1 ? candidates[0] : undefined;
      return !!expected && expected.returns_trigger === true && /^[1-9][0-9]*$/.test(expected.oid) && expected.signature === `${name}()` &&
        row.triggers.some((t) => t.name === name && t.type === type && t.enabled === "O" && t.function === expected.signature && t.function_oid === expected.oid && t.nargs === 0 && t.qual === null && t.constraint_oid === "0" && t.attributes === "" && t.internal === false);
    };
    snapshot[row.tbl] = ["r", "p"].includes(row.relkind) && matches("account_recovery_write_guard", 31) && matches("account_recovery_capture_delete", 9) ? "both_signature_checked" : "missing_or_mismatch";
  }
  return snapshot;
}

function scopedSourceDigest(): string {
  const migrations = readdirSync("supabase/migrations").filter((name) => name.endsWith(".sql"))
    .map((name) => `supabase/migrations/${name}`)
    .filter((path) => /admin_team_atomic_revoke/.test(path) || /account_recovery_|resident_move_in_forms|create table|drop table|alter table/i.test(readFileSync(path, "utf8")));
  const paths = [...migrations, "src/lib/auth/account-purge-manifest.ts", "src/lib/auth/account-recovery-policy.ts"].sort();
  const hash = createHash("sha256");
  for (const path of paths) hash.update(path).update("\0").update(readFileSync(path)).update("\0");
  return hash.digest("hex");
}

/** Compare an observed catalog to explicit debt; a fix must remove its entry. */
function differences(observed: Record<string, string>, known: Record<string, { reason: string }>) {
  const missing = Object.keys(observed).filter((name) => observed[name] === "missing_or_mismatch").sort();
  const expected = Object.keys(known).sort();
  return { newGaps: missing.filter((name) => !expected.includes(name)), fixedDebt: expected.filter((name) => observed[name] === "both_signature_checked"), absent: Object.keys(observed).filter((name) => observed[name] === "absent").sort() };
}
describe("recovery hook debt snapshot", () => {
  it("accounts for the reviewed catalog after the forms migration", () => {
    const migration = readFileSync("supabase/migrations/20261030144900_move_in_forms_recovery_guards.sql", "utf8");
    expect(migration).toContain("before insert or update or delete on public.resident_move_in_forms");
    expect(migration).toContain("after delete on public.resident_move_in_forms");
    expect(scopedSourceDigest()).toBe(sourceDigest.sha256);
    const observed = observedCatalog();
    const projected = process.env.RECOVERY_HOOK_CATALOG ? observed : { ...observed, resident_move_in_forms: "both_signature_checked" };
    expect(differences(projected, KNOWN_RECOVERY_HOOK_GAPS)).toEqual({ newGaps: [], fixedDebt: [], absent: process.env.RECOVERY_HOOK_CATALOG ? sourceDigest.missing_dev_catalog : [] });
    for (const entry of Object.values(KNOWN_RECOVERY_HOOK_GAPS)) expect(entry.reason.trim().length).toBeGreaterThan(20);
  });
  it("detects a newly missing hook and requires fixed debt to be removed", () => {
    expect(differences({ unexpected: "missing_or_mismatch", fixed: "both_signature_checked" }, { fixed: { reason: "review" } }))
      .toEqual({ newGaps: ["unexpected"], fixedDebt: ["fixed"], absent: [] });
  });
});
