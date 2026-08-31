import { describe, expect, it } from "vitest";
import { normalizeLeasePipelineRow } from "@/lib/lease-pipeline-storage";
import { stripLeaseAiDisclaimerFromHtml } from "@/lib/lease-templates/types";
import {
  buildLeasePacketUpdateFromForm,
  leasePacketFormAutoLeaseEnd,
  leasePacketFormRegeneratesDocument,
  leasePacketFormValuesFromRow,
} from "@/lib/lease-packet-edit-form";

describe("lease packet inline edit form", () => {
  const row = normalizeLeasePipelineRow({
    id: "lease-1",
    residentName: "Alex Resident",
    residentEmail: "alex@example.com",
    unit: "Room A",
    notes: "Corner room",
    application: {
      leaseTerm: "12-Month",
      leaseStart: "2026-08-01",
      leaseEnd: "2027-07-31",
      managerRentOverride: "$1,200.00",
      managerUtilitiesOverride: "$80.00",
      roomChoice1: "Room A",
      rentalType: "standard",
    },
  });

  it("hydrates editable values from a lease row", () => {
    expect(leasePacketFormValuesFromRow(row)).toMatchObject({
      unit: "Room A",
      roomChoice: "Room A",
      rentalType: "standard",
      leaseTerm: "12-Month",
      leaseStart: "2026-08-01",
      monthlyRent: "1200",
      monthlyUtilities: "80",
      notes: "Corner room",
    });
  });

  it("auto-computes lease end for fixed terms", () => {
    const values = leasePacketFormValuesFromRow(row);
    expect(leasePacketFormAutoLeaseEnd(values)).toBe("2027-07-31");
  });

  it("builds an update payload for changed rent", () => {
    const baseline = leasePacketFormValuesFromRow(row);
    const next = { ...baseline, monthlyRent: "1300" };
    const built = buildLeasePacketUpdateFromForm("lease-1", next, baseline);
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.input.monthlyRent).toBe(1300);
    }
    expect(leasePacketFormRegeneratesDocument(baseline, next)).toBe(true);
  });

  it("rejects unchanged saves", () => {
    const baseline = leasePacketFormValuesFromRow(row);
    const built = buildLeasePacketUpdateFromForm("lease-1", baseline, baseline);
    expect(built.ok).toBe(false);
  });

  it("normalizes non-string generatedHtml without throwing", () => {
    const normalized = normalizeLeasePipelineRow({
      id: "lease-bad-html",
      generatedHtml: { html: "<p>oops</p>" } as unknown as string,
    });
    expect(normalized.generatedHtml).toBeNull();
  });
});

describe("stripLeaseAiDisclaimerFromHtml", () => {
  it("returns null for non-string input", () => {
    expect(stripLeaseAiDisclaimerFromHtml(null)).toBeNull();
    expect(stripLeaseAiDisclaimerFromHtml(undefined)).toBeNull();
    expect(stripLeaseAiDisclaimerFromHtml("")).toBeNull();
    expect(stripLeaseAiDisclaimerFromHtml({ html: "<p>x</p>" } as unknown as string)).toBeNull();
  });
});
