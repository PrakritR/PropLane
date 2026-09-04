/**
 * AXI-154 — "when two properties are selected pre fill out with first propert
 * and have option to change to another property in applciation form but only to
 * the ones that are selected."
 *
 * A multi-home share is `/rent/apply?ids=a,b,c`. It used to stop at a standalone
 * picker, and choosing one navigated to `?propertyId=<one>` — dropping the other
 * ids, so the applicant could never switch without going back to the link.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildPortfolioApplyHref, parseBrowseIdsParam } from "@/lib/manager-property-links";

const wizard = readFileSync(
  path.join(process.cwd(), "src/components/marketing/rental-application-wizard.tsx"),
  "utf8",
);
const applyClient = readFileSync(
  path.join(process.cwd(), "src/app/(public)/rent/apply/public-apply-client.tsx"),
  "utf8",
);

describe("multi-home apply link", () => {
  it("still builds the shared link with every id, in order", () => {
    const href = buildPortfolioApplyHref(["p-1", "p-2", "p-3"]);
    expect(parseBrowseIdsParam(new URL(href, "https://x").searchParams.get("ids"))).toEqual([
      "p-1",
      "p-2",
      "p-3",
    ]);
  });

  it("opens the wizard on the first shared property", () => {
    const block = wizard.split("const linkedPropertyId =")[1]?.slice(0, 300) ?? "";
    expect(block).toContain("portfolioPropertyIds[0]");
  });

  it("offers exactly the shared set, not the whole public catalogue", () => {
    const block = wizard.split("if (portfolioPropertyIds.length > 1) {")[1]?.slice(0, 400) ?? "";
    expect(block).toContain("portfolioPropertyIds");
    expect(block).toContain("getPropertyForPublicLink");
  });

  it("unlocks the property field only when there is a real choice", () => {
    const block = wizard.split("propertyLocked={")[1]?.slice(0, 420) ?? "";
    expect(block).toContain("portfolioPropertyIds.length > 1");
    // A single shared listing must STAY locked — it is not a choice.
    expect(block).toContain("mode !== \"portal\"");
  });

  it("keeps the standalone picker for the account gate and for an unresolvable link", () => {
    const block = applyClient.split("const portfolioPickerBlocks =")[1]?.slice(0, 300) ?? "";
    expect(block).toContain('view !== "wizard"');
    expect(block).toContain("portfolioProperties.length === 0");
  });

  it("reads the ids only on the public flow", () => {
    const block = wizard.split("const portfolioPropertyIds = useMemo(")[1]?.slice(0, 200) ?? "";
    expect(block).toContain('mode === "public"');
  });
});
