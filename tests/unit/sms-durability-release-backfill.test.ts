import { describe, expect, it, vi } from "vitest";
import { args, assertMigrationPostflights, bindCursor } from "../../scripts/sms-durability-release-backfill.mjs";

describe("SMS release backfill wrapper", () => {
  it("uses fresh target-specific cursors and rejects an old or cross-target cursor", () => {
    const options = args(["--target", "staging", "--cursor-file", "/private/tmp/sms-staging-20260926-completed-receipt-cursor.json"]);
    expect(() => bindCursor(options)).not.toThrow();
    expect(() => bindCursor({ ...options, cursorFile: "/private/tmp/sms-staging-20260925-cursor.json" })).toThrow();
    expect(() => bindCursor({ ...options, target: "production" })).toThrow();
  });

  it("requires both migration postflights in order and stops on either failure", () => {
    const spawn = vi.fn(() => ({ status: 0 }));
    assertMigrationPostflights("staging", spawn);
    expect(spawn.mock.calls.map((call) => call[1][0].split("/").at(-1))).toEqual([
      "sms-durability-release-migrations.mjs", "sms-completed-receipt-release-migration.mjs",
    ]);
    expect(spawn.mock.calls.every((call) => call[1].slice(1).join(" ") === "--target staging --phase postflight")).toBe(true);
    const firstFails = vi.fn(() => ({ status: 1 }));
    expect(() => assertMigrationPostflights("staging", firstFails)).toThrow("SMS migration postflight");
    expect(firstFails).toHaveBeenCalledOnce();
    const secondFails = vi.fn().mockReturnValueOnce({ status: 0 }).mockReturnValueOnce({ status: 1 });
    expect(() => assertMigrationPostflights("staging", secondFails)).toThrow("completed-receipt migration postflight");
    expect(secondFails).toHaveBeenCalledTimes(2);
  });
});
