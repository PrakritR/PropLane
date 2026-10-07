/**
 * Source guard: the vendor fee has ONE name, PROPLANE_SERVICE_FEE_LABEL
 * ("PropLane service fee", src/lib/platform-fees.ts). No vendor-facing surface
 * may render the older bare "PropLane fee" literal, and the label surfaces must
 * read the constant rather than retype it.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..", "..");

/** Surfaces that must read the constant. */
const LABEL_SURFACES = [
  "src/components/portal/vendor-finances-panel.tsx",
  "src/app/print/vendor-payout/[id]/page.tsx",
  "src/lib/vendor-banking/statement.server.ts",
  "src/components/portal/vendor-statement-modal.tsx",
  "src/components/portal/vendor-payouts-settings-extra.tsx",
  "src/components/portal/vendor-refund-modal.tsx",
  "src/components/portal/vendor-invoice-manager-pay-sheet.tsx",
  "src/lib/vendor-banking/refund.server.ts",
  "src/lib/vendor-banking/hold-expiry.server.ts",
];

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(full);
  }
  return out;
}

describe("vendor service fee label", () => {
  it("every label surface reads PROPLANE_SERVICE_FEE_LABEL", () => {
    for (const file of LABEL_SURFACES) {
      const source = readFileSync(join(ROOT, file), "utf8");
      expect(source, `${file} must use the label constant`).toContain("PROPLANE_SERVICE_FEE_LABEL");
    }
  });

  it("no vendor-facing source renders the bare 'PropLane fee' literal", () => {
    const files = [
      ...LABEL_SURFACES.map((f) => join(ROOT, f)),
      ...walk(join(ROOT, "src", "lib", "vendor-banking")),
      ...walk(join(ROOT, "src", "components", "portal")).filter((f) => /\/vendor-[^/]*\.tsx$/.test(f)),
      ...walk(join(ROOT, "src", "app", "print", "vendor-payout")),
    ];
    const offenders = [...new Set(files)].filter((file) => /PropLane fee\b/.test(stripComments(readFileSync(file, "utf8"))));
    expect(offenders.map((f) => f.replace(ROOT, "")), "say 'PropLane service fee' via the constant").toEqual([]);
  });

  it("the ledger fee description is derived from the rate constant, never a typed percent", () => {
    const ledger = stripComments(readFileSync(join(ROOT, "src/lib/vendor-banking/ledger.server.ts"), "utf8"));
    expect(ledger).toContain("vendorServiceFeeDescription()");
    expect(ledger).not.toMatch(/\(3%\)/);
  });

  it("a payout with no fee shows no fee line on the printed receipt", () => {
    const page = readFileSync(join(ROOT, "src/app/print/vendor-payout/[id]/page.tsx"), "utf8");
    expect(page).toMatch(/breakdown\.feeCents > 0 \? \(/);
  });
});
