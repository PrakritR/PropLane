// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FINANCE_NAV_TAB_IDS } from "@/components/portal/finance-destination-nav";

describe("finance destination nav", () => {
  it("lists every finance view in one flat rail", () => {
    expect(FINANCE_NAV_TAB_IDS).toContain("income");
    expect(FINANCE_NAV_TAB_IDS).toContain("expenses");
    expect(FINANCE_NAV_TAB_IDS).toContain("trial-balance");
    expect(FINANCE_NAV_TAB_IDS).toContain("owner-distributions");
    expect(FINANCE_NAV_TAB_IDS.indexOf("income")).toBeLessThan(FINANCE_NAV_TAB_IDS.indexOf("trial-balance"));
  });

  it("uses a left rail on desktop and a single mobile row (no grouped tiers)", () => {
    const source = readFileSync(
      join(process.cwd(), "src/components/portal/finance-destination-nav.tsx"),
      "utf8",
    );
    expect(source).toContain("hidden min-w-[11.5rem] shrink-0 flex-col gap-0.5 lg:flex");
    expect(source).toContain("lg:hidden");
    expect(source).not.toContain("FINANCE_NAV_GROUPS");
    expect(source).not.toContain('appearance="command"');
  });
});
