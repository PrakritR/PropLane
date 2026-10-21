import { describe, expect, it } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { shortStaySourceLabel } from "@/lib/short-stay/guest-stays";
import { withDollar } from "@/components/portal/application-resident-slot-picker";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

describe("manager booking record source label", () => {
  it("names the portal, never the stored token", () => {
    expect(shortStaySourceLabel("guest_portal")).toBe("PropLane portal");
    expect(shortStaySourceLabel("sms_short_stay")).toBe("Text");
    expect(shortStaySourceLabel("public_short_stay_request")).toBe("Public request");
    expect(shortStaySourceLabel("Airbnb")).toBe("Airbnb");
    expect(shortStaySourceLabel(undefined)).toBe("");
  });
});

describe("a stored price never reads $$ in the bed picker", () => {
  it("shows a stored $ price once and adds one to a bare figure", () => {
    expect(withDollar("$175.00")).toBe("$175.00");
    expect(withDollar(" $500.00 ")).toBe("$500.00");
    expect(withDollar("175")).toBe("$175");
    expect(withDollar(500)).toBe("$500");
    const picker = read("src/components/portal/application-resident-slot-picker.tsx");
    expect(picker).toContain("withDollar(slot.price.utilitiesEstimate)");
    expect(picker).toContain("withDollar(slot.price.securityDeposit)");
  });
});

describe("the web channel never carries the PropLane number", () => {
  it("/rent has its own layout with no texting snapshot", () => {
    expect(existsSync(join(process.cwd(), "src/app/(rent)/layout.tsx"))).toBe(true);
    expect(existsSync(join(process.cwd(), "src/app/(public)/rent"))).toBe(false);
    const layout = read("src/app/(rent)/layout.tsx");
    expect(layout).toContain("phone: null, smsHref: null");
    expect(layout).not.toContain("getPublicTextingConfig");
  });

  it("the auth brand panel shows no number and the shell reads none", () => {
    expect(read("src/components/auth/auth-brand-panel.tsx")).not.toMatch(/phone|auth-brand-number/);
    expect(read("src/components/auth/auth-split-shell.tsx")).not.toContain("getPublicTextingConfig");
  });

  it("the short-stay card is found by a data hook, not a duplicated id", () => {
    const sections = read("src/components/marketing/listing-detail-sections.tsx");
    expect(sections).not.toContain('id="short-stay-card"');
    expect(sections).not.toContain('getElementById("short-stay-card")');
    expect(sections).toContain("data-short-stay-card");
  });
});

describe("Leases tabs say loading, not Nothing to review, before the first read", () => {
  it("passes the first-sync flag into the list surface", () => {
    expect(read("src/components/portal/pro-leases.tsx")).toContain("serverSynced");
    expect(read("src/components/portal/pro-leases-pipeline-panel.tsx")).toContain("loading={loading && searchedRows.length === 0}");
  });
});

describe("the application keeps the room the applicant picked", () => {
  it("never defaults a by-room listing to its first room and never lets a link overwrite a saved pick", () => {
    const wizard = read("src/components/marketing/rental-application-wizard.tsx");
    expect(wizard).not.toContain('entireHome ? pid : opts[0]?.value ?? ""');
    expect(wizard).toContain("prev.propertyId.trim() === pid && prev.roomChoice1.trim()");
  });

  it("says why the card form is closed when a bed or room is the reason, not the signature", () => {
    const wizard = read("src/components/marketing/rental-application-wizard.tsx");
    const steps = read("src/components/marketing/rental-wizard-steps.tsx");
    expect(wizard).toContain("paymentBlockedReason={paymentGate.reason}");
    expect(wizard).toContain("Go back to Lease to fix it.");
    expect(steps).toContain('paymentBlockedReason ?? "Finish the signature above to pay the application fee."');
  });
});
