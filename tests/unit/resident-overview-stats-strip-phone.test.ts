import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(resolve(process.cwd(), "src/components/portal/pro-resident-overview-panel.tsx"), "utf8");
const strip = src.slice(src.indexOf("data-rt-kpis") - 400, src.indexOf("data-rt-needs"));

describe("resident record stats strip on a phone", () => {
  it("is a wrapping two-column grid, not a horizontal scroller", () => {
    expect(strip).toContain("max-sm:grid-cols-2");
    expect(strip).not.toContain("max-sm:flex");
    expect(strip).not.toContain("max-sm:min-w-32");
    expect(strip).not.toContain("max-sm:shrink-0");
  });

  it("never truncates a fact's value on a phone (wraps instead)", () => {
    expect(strip).toContain("max-sm:overflow-visible");
    expect(strip).toContain("max-sm:whitespace-normal");
    expect(strip).toContain("max-sm:break-words");
  });
});
