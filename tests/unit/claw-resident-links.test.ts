import { afterEach, describe, expect, it } from "vitest";

import { routeResolves } from "../helpers/route-resolves";
import {
  defaultResidentOnboardingSmsLinks,
  ensureSmsIncludesPortalLink,
  managerPortalPath,
  residentPortalPath,
  residentPortalUrl,
  residentSmsLinkOrigin,
  smsLinkKindForThreadTopic,
  type ResidentSmsLinkKind,
} from "@/lib/claw-resident-links";

const ORIGIN_KEYS = [
  "CLAW_MESSENGER_LINK_ORIGIN",
  "NEXT_PUBLIC_APP_URL",
  "VERCEL_PROJECT_PRODUCTION_URL",
] as const;

afterEach(() => {
  for (const key of ORIGIN_KEYS) delete process.env[key];
});

describe("claw-resident-links", () => {
  it("maps kinds to real resident portal paths", () => {
    expect(residentPortalPath("payments")).toBe("/resident/payments/pending");
    expect(residentPortalPath("lease")).toBe("/resident/lease");
    expect(residentPortalPath("move_in")).toBe("/resident/move-in");
    expect(residentPortalPath("inbox")).toBe("/resident/communication/email/unopened");
    expect(residentPortalPath("services")).toBe("/resident/services");
    expect(residentPortalPath("services_work_orders")).toBe("/resident/services");
    expect(residentPortalPath("apply", { propertyId: "p1", bundleId: "b1" })).toBe(
      "/rent/apply?propertyId=p1&bundle=b1",
    );
  });

  it("uses the canonical PropLane host when legacy overrides remain configured", () => {
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    process.env.CLAW_MESSENGER_LINK_ORIGIN = "https://www.axis-seattle-housing.com";
    expect(residentSmsLinkOrigin()).toBe("https://prop-lane.space");
    expect(residentPortalUrl("payments")).toBe(
      "https://prop-lane.space/resident/payments/pending",
    );
  });

  it("appends a labeled link only when body has no http(s) url", () => {
    const withLink = ensureSmsIncludesPortalLink("Rent is due.", "payments");
    expect(withLink).toContain("Pay / view charges:");
    expect(withLink).toContain("/resident/payments/pending");

    const already = ensureSmsIncludesPortalLink(
      "Open: https://example.com/pay",
      "payments",
    );
    expect(already).toBe("Open: https://example.com/pay");
  });

  it("maps thread topics to link kinds", () => {
    expect(smsLinkKindForThreadTopic("payment")).toBe("payments");
    expect(smsLinkKindForThreadTopic("lease")).toBe("lease");
    expect(smsLinkKindForThreadTopic("move_in")).toBe("move_in");
    expect(smsLinkKindForThreadTopic("maintenance")).toBe("services_work_orders");
    expect(smsLinkKindForThreadTopic("services")).toBe("services");
    expect(smsLinkKindForThreadTopic("general")).toBe("inbox");
  });

  it("onboarding footer includes sign-in, payments, and lease", () => {
    process.env.CLAW_MESSENGER_LINK_ORIGIN = "https://www.axis-seattle-housing.com";
    const lines = defaultResidentOnboardingSmsLinks();
    // `/auth/login` has never existed — it 404s. Every resident onboarding
    // email and SMS carries this link, so the wrong token here means the lease
    // sends and the recipient lands on a dead page, which from the manager's
    // chair is indistinguishable from "the lease never sent".
    expect(lines.some((l) => l.includes("/auth/sign-in"))).toBe(true);
    expect(lines.some((l) => l.includes("/auth/login"))).toBe(false);
    expect(lines.some((l) => l.includes("/resident/payments/pending"))).toBe(true);
    expect(lines.some((l) => l.includes("/resident/lease"))).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Route existence — resolver lives in tests/helpers/route-resolves.ts
 * ------------------------------------------------------------------ */

/**
 * A link builder that names a path with no route is a dead end nobody sees
 * until a recipient clicks it — `/auth/login` shipped in every resident
 * onboarding message and 404'd for as long as it existed. A build does not
 * catch it and neither does an assertion on the literal string, so the paths
 * are checked against the real app router tree.
 */
describe("every path the link builders hand out resolves to a real route", () => {
  const RESIDENT_KINDS: ResidentSmsLinkKind[] = [
    "payments",
    "lease",
    "move_in",
    "inbox",
    "services",
    "services_work_orders",
    "applications",
    "login",
    "signup",
    "browse",
    "apply",
  ];

  it("resolves this test's own fixtures, so a false pass is not possible", () => {
    expect(routeResolves("/auth/sign-in")).toBe(true);
    expect(routeResolves("/rent/browse")).toBe(true); // inside the (public) route group
    expect(routeResolves("/resident/lease")).toBe(true); // via [section]
    expect(routeResolves("/auth/login")).toBe(false); // the bug this guards
    expect(routeResolves("/auth/definitely-not-a-page")).toBe(false);
  });

  it.each(RESIDENT_KINDS)("resident link %s", (kind) => {
    expect(routeResolves(residentPortalPath(kind, { propertyId: "p1" }))).toBe(true);
  });

  it.each([
    "properties",
    "calendar",
    "applications",
    "leases",
    "residents",
    "payments",
    "services_work_orders",
    "services_requests",
    "inbox",
    "relationships",
    "promotion",
  ] as const)("manager link %s", (kind) => {
    expect(routeResolves(managerPortalPath(kind))).toBe(true);
  });
});
