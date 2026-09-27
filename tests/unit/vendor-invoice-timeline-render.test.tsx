// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { VendorInvoiceTimeline } from "@/components/portal/vendor-invoice-timeline";
import { vendorInvoiceTimeline } from "@/lib/vendor-invoices";

afterEach(cleanup);

describe("VendorInvoiceTimeline", () => {
  it("renders one row per step, with an unknown date as an em dash", () => {
    const steps = vendorInvoiceTimeline({
      status: "scheduled",
      submittedAt: "2026-01-01T00:00:00.000Z",
      decidedAt: "2026-01-03T00:00:00.000Z",
      paidAt: null,
      decisionNote: null,
    });
    render(<VendorInvoiceTimeline steps={steps} />);
    const rows = document.querySelectorAll('[data-attr="vendor-invoice-timeline-step"]');
    expect(rows).toHaveLength(4);
    const approvedRow = document.querySelector('[data-step="approved"]');
    expect(approvedRow?.textContent).toContain("—");
  });

  it("renders the short Rejected branch as two rows", () => {
    const steps = vendorInvoiceTimeline({
      status: "rejected",
      submittedAt: "2026-01-01T00:00:00.000Z",
      decidedAt: "2026-01-02T00:00:00.000Z",
      paidAt: null,
      decisionNote: "Missing W-9",
    });
    render(<VendorInvoiceTimeline steps={steps} />);
    expect(document.querySelectorAll('[data-attr="vendor-invoice-timeline-step"]')).toHaveLength(2);
    expect(document.querySelector('[data-step="rejected"]')?.textContent).toContain("Missing W-9");
  });
});
