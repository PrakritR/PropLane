import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { args, assertMigrationPostflights, bindCursor, BACKFILL_HASH } from "../../scripts/sms-durability-release-backfill.mjs";

describe("SMS release backfill wrapper", () => {
  it("pins the reviewed core source bytes", () => {
    const bytes = readFileSync(new URL("../../scripts/backfill-sms-projection.mjs", import.meta.url));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(BACKFILL_HASH);
  });
  it("uses fresh target-specific cursors and rejects an old or cross-target cursor", () => {
    const options = args(["--target", "staging", "--cursor-file", "/private/tmp/sms-staging-20260926-reviewed-c6a3c61c-cursor.json"]);
    expect(() => bindCursor(options)).not.toThrow();
    expect(() => bindCursor({ ...options, cursorFile: "/private/tmp/sms-staging-20260925-cursor.json" })).toThrow();
    expect(() => bindCursor({ ...options, target: "production" })).toThrow();
  });

  it("requires all migration postflights in order and stops on failure", () => {
    const spawn = vi.fn(() => ({ status: 0 }));
    assertMigrationPostflights("staging", spawn);
    expect(spawn.mock.calls.map((call) => call[1][0].split("/").at(-1))).toEqual([
      "sms-message-sid-prefix-release-migration.mjs",
    ]);
    expect(spawn.mock.calls.every((call) => call[1].slice(1).join(" ") === "--target staging --phase postflight")).toBe(true);
    const firstFails = vi.fn(() => ({ status: 1 }));
    expect(() => assertMigrationPostflights("staging", firstFails)).toThrow("SMS SID correction migration postflight");
    expect(firstFails).toHaveBeenCalledOnce();
  });
});
