import { describe, expect, it } from "vitest";
import {
  prospectGateKey,
  prospectPortalReturnPath,
  prospectPublicReturnPath,
  resolveProspectGateView,
} from "@/lib/prospect-public-gate";
import {
  buildProspectApplyHref,
  buildProspectMessageHref,
  buildProspectTourHref,
  residentPortalListingMessagePath,
  residentPortalTourSchedulePath,
} from "@/lib/prospect-public-nav";

describe("prospect-public-gate", () => {
  it("uses legacy bare id for apply gate keys", () => {
    expect(prospectGateKey("apply", "mgr-abc")).toBe("mgr-abc");
    expect(prospectGateKey("tour", "mgr-abc")).toBe("tour:mgr-abc");
    expect(prospectGateKey("message", "mgr-abc")).toBe("message:mgr-abc");
  });

  it("keys lease gates and returns signers to the portal lease", () => {
    expect(prospectGateKey("lease", "mgr-abc")).toBe("lease:mgr-abc");
    expect(prospectPortalReturnPath("lease", { propertyId: "mgr-abc" })).toBe("/resident/lease");
    expect(prospectPublicReturnPath("lease", { propertyId: "mgr-abc" })).toBe("/resident/lease");
  });

  it("resolves gate view for signed-in non-residents", () => {
    expect(
      resolveProspectGateView({
        gateKey: "mgr-1",
        guestContinue: false,
        signedInNonResident: true,
      }),
    ).toBe("signed-in-create-resident");
    // PLAN-0924-1421 closed guest continue: a stale flag must not unlock the action.
    expect(
      resolveProspectGateView({
        gateKey: "mgr-1",
        guestContinue: true,
        signedInNonResident: true,
      }),
    ).toBe("signed-in-create-resident");
    expect(
      resolveProspectGateView({
        gateKey: "mgr-1",
        guestContinue: true,
        signedInNonResident: false,
      }),
    ).toBe("account-prompt");
    expect(
      resolveProspectGateView({
        gateKey: "mgr-1",
        guestContinue: false,
        signedInNonResident: false,
        hasResidentRole: true,
      }),
    ).toBe("resident-portal");
    expect(
      resolveProspectGateView({
        gateKey: "message:mgr-1",
        guestContinue: false,
        signedInNonResident: false,
        hasResidentRole: false,
      }),
    ).toBe("account-prompt");
  });

  it("builds portal and public return paths", () => {
    expect(prospectPortalReturnPath("tour", { propertyId: "p1" })).toBe(
      "/resident/tour/schedule?propertyId=p1",
    );
    expect(prospectPublicReturnPath("message", { propertyId: "p1" })).toBe(
      "/rent/tours-contact?tab=message&propertyId=p1",
    );
  });
});

describe("prospect-public-nav", () => {
  const residentAuth = { ready: true, userId: "u1", hasResidentRole: true };
  const guestAuth = { ready: true, userId: null, hasResidentRole: false };

  it("routes residents into portal surfaces", () => {
    expect(buildProspectTourHref("p1", residentAuth)).toBe(residentPortalTourSchedulePath("p1"));
    expect(buildProspectMessageHref("p1", residentAuth)).toBe(residentPortalListingMessagePath("p1"));
    expect(buildProspectApplyHref({ propertyId: "p1" }, residentAuth)).toBe(
      "/resident/applications/apply?propertyId=p1",
    );
  });

  it("keeps guests on public marketing paths", () => {
    expect(buildProspectTourHref("p1", guestAuth)).toBe("/rent/tours-contact?propertyId=p1");
    expect(buildProspectMessageHref("p1", guestAuth)).toContain("tab=message");
    expect(buildProspectApplyHref({ propertyId: "p1" }, guestAuth)).toBe("/rent/apply?propertyId=p1");
  });
});
