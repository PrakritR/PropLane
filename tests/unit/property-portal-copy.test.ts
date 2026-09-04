import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("property portal copy", () => {
  it("does not expose the primary admin personal email in manager property UI", () => {
    const panelPath = resolve(process.cwd(), "src/components/portal/pro-house-properties-panel.tsx");
    const source = readFileSync(panelPath, "utf8");
    expect(source).not.toContain("founders@axis-seattle-housing.com");
  });
});
