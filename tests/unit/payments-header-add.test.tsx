// PLAN-0917-1314 — Incoming Add charge stays in the command bar even with
// no pipeline houses and no workspace houses.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function src(rel: string) {
  return readFileSync(join(process.cwd(), rel), "utf8");
}

describe("Incoming header Add charge is constant", () => {
  it("renders Add charge without a property or workspace gate", () => {
    const payments = src("src/components/portal/pro-payments.tsx");
    expect(payments).toContain('label="Add charge"');
    expect(payments).toContain('data-attr="payments-add-top"');
    expect(payments).toContain('dataAttr: "payments-empty-add"');
    expect(payments).not.toContain("canCreatePayment");
    const primary = payments.slice(payments.indexOf("primary={"));
    expect(primary).toContain('label="Add charge"');
    expect(primary).not.toContain("ownedPropertyIdsForUser");
  });
});
