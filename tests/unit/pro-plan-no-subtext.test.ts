import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const src = readFileSync("src/components/portal/pro-plan.tsx", "utf8");

describe("Billing plan heading has no subtext", () => {
  it("uses Choose your plan and drops the muted sentence under it", () => {
    expect(src).toContain("Choose your plan");
    expect(src).not.toContain("Choose the plan that fits your portfolio");
    expect(src).not.toContain("Start with the tools you need today and change plans as your portfolio grows.");
  });

  it("keeps Monthly/Annual on the same row as the heading", () => {
    expect(src).toMatch(/sm:flex-row sm:items-center sm:justify-between/);
  });
});
