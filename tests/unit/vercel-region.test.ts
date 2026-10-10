import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("vercel.json", () => {
  it("runs functions in pdx1, beside the us-west-2 database", () => {
    const config = JSON.parse(readFileSync(path.resolve(process.cwd(), "vercel.json"), "utf8")) as { regions?: string[]; crons?: unknown[] };
    expect(config.regions).toEqual(["pdx1"]);
    expect(config.crons?.length).toBeGreaterThan(0);
  });
});
