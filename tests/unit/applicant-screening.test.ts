import { afterEach, describe, expect, it } from "vitest";
import {
  APPLICANT_DEFAULT_PACKAGE,
  applicantScreeningQuote,
  applicantUpgradeCents,
  defaultApplicantScreeningSettings,
  normalizeApplicantScreeningSettings,
  resolveApplicantScreeningOffer,
} from "@/lib/screening/applicant-screening";
import { checkrPackageRank, checkrUpgradeCostCents } from "@/lib/checkr/packages";
import { applicationIdentityVerified } from "@/lib/checkr/identity";
import { parseCheckrReportSnapshot } from "@/lib/checkr/report-snapshot";

const env = { ...process.env };
afterEach(() => {
  process.env = { ...env };
});

describe("applicant-paid Starter checkout pricing", () => {
  it("defaults to Starter at $24.99 with no add-on", () => {
    const quote = applicantScreeningQuote({ includeIdCheck: false });
    expect(APPLICANT_DEFAULT_PACKAGE).toBe("starter");
    expect(quote).toMatchObject({ packageSlug: "starter", packageCents: 2499, idCheckCents: 0, totalCents: 2499, addOnProducts: [] });
  });

  it("adds the $2.95 ID add-on into the same order total", () => {
    const quote = applicantScreeningQuote({ includeIdCheck: true });
    expect(quote.idCheckCents).toBe(295);
    expect(quote.totalCents).toBe(2794);
    expect(quote.addOnProducts).toEqual(["identity_verification"]);
  });

  it("follows the env price overrides, recomputed on the server", () => {
    process.env.CHECKR_STARTER_PRICE_CENTS = "2999";
    process.env.CHECKR_IDENTITY_ADDON_PRICE_CENTS = "350";
    expect(applicantScreeningQuote({ includeIdCheck: true }).totalCents).toBe(3349);
  });
});

describe("manager upgrade pricing", () => {
  it("charges only the package difference", () => {
    expect(applicantUpgradeCents("starter", "essential")).toBe(1000);
    expect(applicantUpgradeCents("starter", "complete")).toBe(2000);
    expect(applicantUpgradeCents("essential", "complete")).toBe(1000);
  });

  it("never charges for the same or a lower package", () => {
    expect(checkrUpgradeCostCents("essential", "essential")).toBe(0);
    expect(checkrUpgradeCostCents("complete", "starter")).toBe(0);
    expect(checkrPackageRank("starter")).toBeLessThan(checkrPackageRank("essential"));
    expect(checkrPackageRank("essential")).toBeLessThan(checkrPackageRank("complete"));
  });
});

describe("per-listing defaults", () => {
  it("is ON for PropLane-managed workspaces and OFF for self-serve", () => {
    expect(defaultApplicantScreeningSettings(true)).toEqual({ idCheck: true, backgroundCheck: true, idUnlock: "clear" });
    expect(defaultApplicantScreeningSettings(false)).toEqual({ idCheck: false, backgroundCheck: false, idUnlock: "clear" });
  });

  it("a saved choice beats the default, per check, and garbage falls back", () => {
    const managed = defaultApplicantScreeningSettings(true);
    expect(normalizeApplicantScreeningSettings({ idCheck: false }, managed)).toEqual({ idCheck: false, backgroundCheck: true, idUnlock: "clear" });
    expect(normalizeApplicantScreeningSettings({ backgroundCheck: true }, defaultApplicantScreeningSettings(false))).toEqual({
      idCheck: false,
      backgroundCheck: true,
      idUnlock: "clear",
    });
    expect(normalizeApplicantScreeningSettings({ idUnlock: "order" }, managed).idUnlock).toBe("order");
    expect(normalizeApplicantScreeningSettings({ idUnlock: "never" }, managed).idUnlock).toBe("clear");
    expect(normalizeApplicantScreeningSettings("nope", managed)).toEqual(managed);
    expect(normalizeApplicantScreeningSettings({ idCheck: "yes" }, managed)).toEqual(managed);
  });
});

describe("what the applicant is offered", () => {
  const on = { idCheck: true, backgroundCheck: true };
  it("offers nothing when both are off", () => {
    expect(resolveApplicantScreeningOffer({ settings: { idCheck: false, backgroundCheck: false }, idCheckAvailable: true, backgroundCheckConfigured: true })).toEqual({ kind: "none" });
  });
  it("fails closed to 'ID check unavailable' when the ID check is on but not available", () => {
    expect(resolveApplicantScreeningOffer({ settings: on, idCheckAvailable: false, backgroundCheckConfigured: true })).toEqual({ kind: "id_unavailable" });
    expect(resolveApplicantScreeningOffer({ settings: { idCheck: true, backgroundCheck: false }, idCheckAvailable: false, backgroundCheckConfigured: true })).toEqual({ kind: "id_unavailable" });
  });
  it("offers the order with the exact total, ID included only when asked", () => {
    const both = resolveApplicantScreeningOffer({ settings: on, idCheckAvailable: true, backgroundCheckConfigured: true });
    expect(both.kind === "offer" && both.quote.totalCents).toBe(2794);
    const bg = resolveApplicantScreeningOffer({ settings: { idCheck: false, backgroundCheck: true }, idCheckAvailable: false, backgroundCheckConfigured: true });
    expect(bg.kind === "offer" && bg.quote.totalCents).toBe(2499);
  });
  it("offers nothing when Checkr itself is not configured", () => {
    expect(resolveApplicantScreeningOffer({ settings: { idCheck: false, backgroundCheck: true }, idCheckAvailable: false, backgroundCheckConfigured: false })).toEqual({ kind: "none" });
  });
});

describe("the Verified fact", () => {
  const base = { status: "complete" as const, addOnProducts: ["identity_verification" as const], reportSnapshot: { identity_verification: { status: "clear" } } };
  it("is true only when Checkr's ID product cleared on a completed check", () => {
    expect(applicationIdentityVerified(base)).toBe(true);
  });
  it("is never true while pending, unordered, flagged, or absent", () => {
    expect(applicationIdentityVerified({ ...base, status: "pending" })).toBe(false);
    expect(applicationIdentityVerified({ ...base, addOnProducts: undefined })).toBe(false);
    expect(applicationIdentityVerified({ ...base, reportSnapshot: { identity_verification: { status: "consider" } } })).toBe(false);
    expect(applicationIdentityVerified({ ...base, reportSnapshot: {} })).toBe(false);
    expect(applicationIdentityVerified(null)).toBe(false);
  });
  it("survives an upgrade through the carried result only when that was clear", () => {
    expect(applicationIdentityVerified({ status: "complete", reportSnapshot: {}, carriedIdentity: { status: "clear", orderId: "ord_1" } })).toBe(true);
    expect(applicationIdentityVerified({ status: "complete", reportSnapshot: {}, carriedIdentity: { status: "consider", orderId: "ord_1" } })).toBe(false);
  });
});

describe("no ID evidence is persisted", () => {
  it("the stored snapshot keeps product status and reasons only", () => {
    const snapshot = parseCheckrReportSnapshot({
      identity_verification: {
        status: "clear",
        consider_reasons: [],
        document_number: "D1234567",
        id_front_url: "https://example.com/front.jpg",
        selfie_url: "https://example.com/selfie.jpg",
        date_of_birth: "1990-01-01",
      },
      ssn: "111223334",
    });
    expect(snapshot?.identity_verification).toEqual({ status: "clear", consider_reasons: [] });
    const serialized = JSON.stringify(snapshot);
    for (const leak of ["D1234567", "front.jpg", "selfie.jpg", "1990-01-01", "111223334"]) {
      expect(serialized).not.toContain(leak);
    }
  });
});
