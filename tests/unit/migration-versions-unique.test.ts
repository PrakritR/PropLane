import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Supabase records applied migrations by VERSION (the numeric filename prefix),
 * not by filename. So two files sharing a prefix are one entry in the ledger:
 * whichever runs first records the version, and the other is skipped forever as
 * "already applied" — silently, with no error anywhere.
 *
 * That is not hypothetical. `20260904120000` was used twice, by
 * `manager_assistant_emails` and `work_order_human_references`. The first won on
 * every environment, and `work_order_reference_counters` was missing from dev AND
 * production until 2026-09-06 — discovered only because someone went looking for
 * an unrelated missing table. `db:push` cannot repair it: the version is recorded,
 * so it has nothing left to do.
 *
 * A duplicate prefix is therefore never a style problem. It is a migration that
 * will never run.
 */
describe("supabase migration versions", () => {
  const files = readdirSync(join(process.cwd(), "supabase/migrations")).filter((f) =>
    f.endsWith(".sql"),
  );

  it("has migrations to check", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it("gives every migration a unique version prefix", () => {
    const byVersion = new Map<string, string[]>();
    for (const file of files) {
      const version = file.split("_")[0]!;
      byVersion.set(version, [...(byVersion.get(version) ?? []), file]);
    }
    const collisions = [...byVersion.entries()].filter(([, group]) => group.length > 1);
    expect(
      collisions.map(([version, group]) => `${version}: ${group.join(" + ")}`),
      "two migrations sharing a version means the second one never runs — renumber it",
    ).toEqual([]);
  });

  it("starts every migration with a 14-digit timestamp", () => {
    const malformed = files.filter((f) => !/^\d{14}_/.test(f));
    expect(malformed, "a version Supabase cannot order is a version it may skip").toEqual([]);
  });
});
