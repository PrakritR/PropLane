// @vitest-environment jsdom
// Portal sweep round 5 (vendor): V3 finance formatting + vocabulary, V4 Tax rows + count, V5 date format in
// the pop-up rail, V6 empty previews + bank name, V8 consent copy. Presentation only - no amount changes.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { useRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { formatMoney } from "@/components/portal/portal-payouts-panel";
import { PopupFormSnapshot, readPopupFields } from "@/components/ui/popup-form-context";
import { vendorOverviewRows } from "@/lib/vendor-banking/overview-display";
import { bankAccountLabel, titleCaseBankName } from "@/lib/vendor-banking/bank-label";
import { form1099StatusLabel } from "@/lib/vendor-banking/tax";
import { VENDOR_DOCUMENT_SECTIONS, isVendorDocumentRowHidden } from "@/lib/vendor-documents";
import { VENDOR_SMS_CONSENT_COPY } from "@/lib/vendor-sms-consent-copy";

const read = (rel: string) => readFileSync(join(process.cwd(), rel), "utf8");

afterEach(cleanup);

describe("V3 Finances Overview: one money format, Services not Jobs", () => {
  const data = {
    balance: { source: "stripe" as const, availableCents: 13550, pendingCents: 0, owedCents: 15000, paidThisYearCents: 9700, currency: "usd" },
    month: { monthKey: "2026-10", earnedCents: 0, spentCents: 1234, profitCents: 0, jobs: 3 },
  };
  const rows = vendorOverviewRows(data, formatMoney);

  it("formats every figure with cents, exactly like the page's balance strip", () => {
    expect(rows.find((r) => r.id === "owed")?.value).toBe(formatMoney(15000, "usd"));
    expect(rows.find((r) => r.id === "owed")?.value).toBe("$150.00");
    expect(rows.find((r) => r.id === "spent")?.value).toBe("$12.34");
    expect(rows.map((r) => r.value).filter((v) => v.startsWith("$")).every((v) => /\.\d{2}$/.test(v))).toBe(true);
  });

  it("says Services (October), never Jobs", () => {
    const services = rows.find((r) => r.id === "services");
    expect(services).toEqual({ id: "services", label: "Services (October)", value: "3" });
    expect(rows.map((r) => r.label).join(" ")).not.toMatch(/jobs/i);
  });

  it("the Overview body draws no second tile row and the balance strip carries no Held-by note", () => {
    expect(read("src/components/portal/vendor-finances-overview.tsx")).not.toContain("PortalStatStrip");
    const balance = read("src/components/portal/vendor-finances-balance.tsx");
    expect(balance).not.toContain("note: figures.heldReason");
    expect(balance).toContain('if (figures.heldReasonKind === "proplane")');
  });

  it("the Dashboard says services: Open services, and no 'Held by PropLane' sentence", () => {
    const dashboard = read("src/components/portal/vendor-dashboard.tsx");
    expect(dashboard).toContain('label="Open services"');
    expect(dashboard).not.toContain("Open jobs");
    expect(dashboard).toContain('"service" : "services"} waiting on a bid');
    expect(read("src/components/portal/vendor-dashboard-balance-card.tsx")).not.toMatch(/held by PropLane/i);
  });
});

describe("V4 Documents > Tax", () => {
  it("the Tax tab has one W-9 row: the empty 'Signed W-9' placeholder is hidden, an uploaded file still lists", () => {
    expect(isVendorDocumentRowHidden("tax", "w9", false)).toBe(true);
    expect(isVendorDocumentRowHidden("tax", "w9", true)).toBe(false);
    expect(isVendorDocumentRowHidden("tax", "income_tax_return", false)).toBe(false);
    expect(isVendorDocumentRowHidden("insurance", "w9", false)).toBe(false);
  });

  it("record count = W-9 row + tax-year rows + the visible document rows", () => {
    const taxKinds = VENDOR_DOCUMENT_SECTIONS.find((s) => s.id === "tax")!.kinds;
    const visible = taxKinds.filter((kind) => !isVendorDocumentRowHidden("tax", kind, false));
    // The tax panel renders 1 W-9 row and one row per tax year; the upload list renders `visible`.
    const years = 1;
    expect(1 + years + visible.length).toBe(taxKinds.length + years);
  });

  it("the 1099 line is a short fact", () => {
    const over = { year: 2026, overThreshold: true, thresholdCents: 200_000 } as Parameters<typeof form1099StatusLabel>[0];
    expect(form1099StatusLabel({ ...over, overThreshold: false }, { hasW9: true, currentYear: 2026 })).toBe("No 1099 needed");
    expect(form1099StatusLabel(over, { hasW9: false, currentYear: 2026 })).toBe("W-9 needed for 1099");
    expect(form1099StatusLabel(over, { hasW9: true, currentYear: 2026 }).length).toBeLessThan(24);
  });

  it("the tax panel shows the year as a row fact, with no bare-year title and no W-9 section chrome", () => {
    const panel = read("src/components/portal/vendor-tax-panel.tsx");
    expect(panel).toContain('title="Tax summary"');
    expect(panel).not.toContain("title={String(year.year)}");
    expect(panel).not.toContain("PortalSettingsSection");
    expect(panel).not.toContain("Not submitted</PortalSettingsRow>");
  });
});

describe("V5 pop-up rail dates", () => {
  it("a date input reads as 'Oct 13, 2026', never the ISO string", () => {
    const root = document.createElement("div");
    root.innerHTML = '<label>Date<input type="date" value="2026-10-13"></label>';
    expect(readPopupFields(root).map(({ label, value }) => ({ label, value }))).toEqual([{ label: "Date", value: "Oct 13, 2026" }]);
  });
});

describe("V6 empty previews + bank name", () => {
  it("the generic snapshot lists only fields with a value (no 'Not set' rows), and is absent when all are blank", () => {
    function Form({ amount }: { amount: string }) {
      const ref = useRef<HTMLDivElement>(null);
      return (
        <>
          <div ref={ref}>
            <label>Amount<input defaultValue={amount} /></label>
            <label>Note<input defaultValue="" /></label>
          </div>
          <PopupFormSnapshot formRef={ref} />
        </>
      );
    }
    const empty = render(<Form amount="" />);
    expect(empty.container.querySelector('[data-attr="popup-draft-preview"]')).toBeNull();
    expect(empty.container.textContent).not.toContain("Not set");
    empty.unmount();
    const filled = render(<Form amount="38.40" />);
    return new Promise<void>((resolve) =>
      setTimeout(() => {
        const text = filled.container.querySelector('[data-attr="popup-draft-preview"]')?.textContent ?? "";
        expect(text).toContain("38.40");
        expect(text).not.toContain("Not set");
        expect(text).not.toContain("Note");
        resolve();
      }, 30),
    );
  });

  it("Request payment / Submit bid preview exists only once a value is set; Next is disabled on an empty Service step for every door that needs a service", () => {
    const wizard = read("src/components/portal/vendor-quote-wizard.tsx");
    expect(wizard).toContain("job || when.trim() || labor.trim() ?");
    expect(wizard).not.toContain('"Not set", warn');
    // Bid and visit need a service; a payment request is valid without one (PRP-254), so its Next stays enabled.
    expect(wizard).toContain('nextDisabled={door !== "invoice" && currentId === "job" && !job}');
  });

  it("Withdraw has one heading and no preview until an amount is set", () => {
    const sheet = read("src/components/portal/payout-withdraw-sheet.tsx");
    expect(sheet).toContain('previewLabel="Withdrawal"');
    expect(sheet).not.toContain('previewLabel="Withdrawal preview"');
    expect(sheet).not.toContain('title="Withdrawal"');
    expect(sheet).toContain("amountCents > 0 ?");
    expect(sheet).not.toContain('"Not set"');
  });

  it("title-cases an ALL-CAPS bank name, leaves a mixed-case one alone", () => {
    expect(titleCaseBankName("STRIPE TEST BANK")).toBe("Stripe Test Bank");
    expect(bankAccountLabel({ label: "STRIPE TEST BANK", last4: "6789" })).toBe("Stripe Test Bank ····6789");
    expect(titleCaseBankName("BANK OF AMERICA")).toBe("Bank of America");
    expect(titleCaseBankName("TD BANK")).toBe("TD Bank");
    expect(titleCaseBankName("Chase")).toBe("Chase");
    expect(titleCaseBankName("")).toBe("");
  });
});

describe("V7 invoice timeline", () => {
  it("states are plain glyph facts, not Badge pills", () => {
    for (const file of ["vendor-invoice-timeline", "vendor-payment-status-timeline", "vendor-payout-timeline"]) {
      const src = read(`src/components/portal/${file}.tsx`);
      expect(src).not.toContain("<Badge");
      expect(src).toContain("VendorTimelineState");
    }
  });
});

describe("V8 vendor Settings", () => {
  it("consent copy says services", () => {
    expect(VENDOR_SMS_CONSENT_COPY).toContain("texts about services".replace("texts", "Text me"));
    expect(VENDOR_SMS_CONSENT_COPY).not.toMatch(/jobs/i);
  });

  it("Preferences and Account use different icons, and the Profile page does not repeat its heading", () => {
    const panel = read("src/components/portal/vendor-settings-panel.tsx");
    expect(panel).toContain("preferences: SlidersHorizontal");
    expect(panel).toContain("account: UserCog");
    expect(panel).not.toContain('<PortalSettingsSection title="Profile"');
  });

  it("the payout schedule drops the duplicate Next payout row while manual", () => {
    const panel = read("src/components/portal/portal-payouts-panel.tsx");
    expect(panel).toContain('schedule.interval !== "manual" ? (');
  });
});

describe("V9 page frame", () => {
  it("Dashboard, Finances and vendor Communication opt into the page frame; Services and Documents keep their band as a direct child", () => {
    expect(read("src/components/portal/vendor-dashboard.tsx")).toContain("pageFrame");
    expect(read("src/components/portal/vendor-finances-balance.tsx")).toContain("compactFilterRow pageFrame");
    expect(read("src/components/portal/vendor-communication.tsx")).toContain("pageFrame");
    for (const file of ["vendor-work-orders-panel", "vendor-documents-panel"]) {
      const src = read(`src/components/portal/${file}.tsx`);
      expect(src).not.toMatch(/<div className="mb-2 max-lg:mb-1.5">\s*<RecordTabBand/);
    }
  });
});
