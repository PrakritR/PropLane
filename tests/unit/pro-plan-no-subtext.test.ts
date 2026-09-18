import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/components/portal/pro-plan.tsx", "utf8");

describe("Billing comparison heading has no subtext", () => {
  it("uses Choose your plan on the same row as Monthly / Annual", () => {
    expect(source).toContain("Choose your plan");
    expect(source).toContain("sm:items-center");
    expect(source).not.toContain("Choose the plan that fits your portfolio");
    expect(source).not.toContain("Start with the tools you need today");
  });
});
