import { describe, expect, it } from "vitest";
// @ts-expect-error - a plain .mjs script; its argument parser is the unit under test
import { parseArgs } from "../../scripts/merge-conversations-backfill.mjs";

describe("merge-conversations-backfill arguments", () => {
  it("is a dry run by default", () => {
    expect(parseArgs([])).toMatchObject({ apply: false, cursorFile: null });
    expect(parseArgs(["--dry-run"]).apply).toBe(false);
  });

  it("--apply needs a cursor file so a long run can resume", () => {
    expect(() => parseArgs(["--apply"])).toThrow(/cursor-file/);
    expect(parseArgs(["--apply", "--cursor-file", "/tmp/c.json"])).toMatchObject({ apply: true, cursorFile: "/tmp/c.json" });
  });

  it("refuses unknown flags and a nonsense owner limit", () => {
    expect(() => parseArgs(["--force"])).toThrow(/Unknown option/);
    expect(() => parseArgs(["--limit-owners", "0"])).toThrow(/positive/);
  });
});
