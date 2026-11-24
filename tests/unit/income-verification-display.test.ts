import { describe, expect, it } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { buildApplicationHtml } from "@/lib/manager-application-html";
import { buildApplicationPdf } from "@/lib/manager-application-pdf";

function row(over: Partial<DemoApplicantRow> = {}): DemoApplicantRow {
  return {
    id: "PROPLANE-INC001",
    name: "Ava Prospect",
    email: "ava@example.com",
    bucket: "pending",
    property: "Test House",
    propertyId: "prop-1",
    stage: "Room 3",
    detail: "",
    application: { fullLegalName: "Ava Prospect", monthlyIncome: "4800", employer: "Acme", customFieldAnswers: [] },
    ...over,
  };
}
const verified = { source: "plaid" as const, monthlyIncomeCents: 485000, months: 3, depositCount: 6, historyDays: 90, verifiedAt: "2026-11-18T00:00:00.000Z" };

describe("manager income fact", () => {
  it("the HTML builder draws stated vs verified as one fact", () => {
    const html = buildApplicationHtml(row({ incomeVerification: verified }));
    expect(html).toContain("$4,800/mo stated · ✓ $4,850/mo avg of payroll deposits, last 90 days (6 deposits)");
  });

  it("the HTML builder draws no income fact without a verification", () => {
    expect(buildApplicationHtml(row())).not.toContain("avg of payroll deposits");
  });

  it("the PDF builder takes a verified row (glyph-free for the standard font)", async () => {
    const pdf = await buildApplicationPdf(row({ incomeVerification: verified }));
    expect(String.fromCharCode(...pdf.slice(0, 4))).toBe("%PDF");
  });
});
