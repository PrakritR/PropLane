import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MIGRATION, parseOptions, reviewedSource } from "../../scripts/sms-retained-historical-release-migration.mjs";
import { sha256 } from "../../scripts/sms-durability-release-manifest.mjs";

const sql = readFileSync(new URL("../../supabase/migrations/20260926190000_sms_retained_historical_source.sql", import.meta.url), "utf8");

describe("retained historical source migration", () => {
  it("pins the exact eighth source after seven applied migrations", () => {
    expect(sha256(sql)).toBe(MIGRATION.hash);
    expect(reviewedSource()).toMatchObject({ sql });
    expect(sql).toContain("0ea5bf25cd933b4f524f873fdadbbe0408914d2e6e4efa7670ff951c2c2dc00f");
    expect(sql).toContain("2026-09-26 00:00:00+00");
    expect(sql).toContain("'retained:inbound_sms_log'");
    expect(sql).not.toContain("create or replace function public.import_sms_projection_historical_event");
    expect(sql).not.toContain("create or replace function public.resolve_sms_completed_receipt_original");
    expect(sql).not.toContain("insert into public.sms_projection_aliases");
  });

  it("requires an exact target, apply authorization, and a private fresh backup", () => {
    expect(parseOptions(["--target", "dev"])).toMatchObject({ phase: "preflight", target: "dev" });
    expect(() => parseOptions(["--target", "other"])).toThrow();
    expect(() => parseOptions(["--target", "production", "--phase", "apply"])).toThrow();
    expect(() => parseOptions(["--target", "staging", "--phase", "apply", "--apply-authorized",
      "--backup-file", "/private/tmp/unbound.dump"])).toThrow();
  });
});
