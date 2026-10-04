import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The vendor service page's Estimate & bid section never renders a status as a rounded pill, and
 * the retired "quote" wording stays out of the vendor Services UI (service-lifecycle.ts).
 */
describe("vendor Services bid UI is plain text, not pills", () => {
  const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

  it("the panel and the answer section never wrap a status in a rounded-full portal-badge-pending chip", () => {
    for (const file of ["src/components/portal/vendor-work-orders-panel.tsx", "src/components/portal/vendor-estimate-bid-section.tsx"]) {
      expect(read(file), file).not.toMatch(/rounded-full[^"]*portal-badge-pending/);
    }
  });

  it("no retired quote / Potential / Withdraw wording in the vendor Services UI copy", () => {
    for (const file of [
      "src/components/portal/vendor-work-orders-panel.tsx",
      "src/components/portal/vendor-estimate-bid-section.tsx",
      "src/components/portal/vendor-quote-wizard.tsx",
      "src/lib/vendor-work-order-tabs.ts",
    ]) {
      const copy = read(file)
        // Strings only: identifiers such as quoteMode / VendorQuoteWizard / data-attrs are not copy.
        .match(/"[^"\n]*"|`[^`\n]*`/g)
        ?.filter((literal) => !/^"(?:vendor-|@\/|\.|use client)/.test(literal))
        .join("\n") ?? "";
      expect(copy, file).not.toMatch(/Send quote|Add quote|Submit quote|Withdraw|Can't do it|Mark done|Potential/);
    }
  });
});
