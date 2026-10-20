// @vitest-environment jsdom
/**
 * Web vs Messages, never mixed (captain, Oct 20): everything under /rent is the web channel. Browse, the listing,
 * its room modal, tours and apply never show a phone number, a "Text us" button, an sms:/tel: link or a prefilled
 * message; the homepage keeps the number. A listing's actions go through a resident account into the portal, and the
 * anonymous booking route is retired.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import type { MockProperty } from "@/data/types";
import type { ListingRichContent } from "@/data/listing-rich-content";

const route = vi.hoisted(() => ({ pathname: "/rent/listings/prop-1" }));
vi.mock("next/navigation", async (orig) => ({ ...(await orig<typeof import("next/navigation")>()), usePathname: () => route.pathname }));
vi.mock("@/components/marketing/listing-location-block", () => ({ ListingLocationBlock: () => null }));
vi.mock("@/hooks/use-prospect-contact-autofill", () => ({
  useProspectContactAutofill: () => ({ ready: true, userId: null, hasResidentRole: false }),
}));
vi.mock("@/lib/portal-mobile-top-chrome", () => ({
  getPortalScrollRoot: () => null,
  syncPortalDetailDestinationOffset: () => 0,
  syncPortalMobileTopChrome: () => 0,
}));

import { ListingDetailSections } from "@/components/marketing/listing-detail-sections";
import { PublicTextingProvider } from "@/components/marketing/public-texting-context";
import { FooterTextNumber, isRentPath } from "@/components/layout/footer-text-number";
import { POST as retiredShortStayRequest } from "@/app/api/public/short-stay-request/route";

const NUMBER = "+12064420188";
const NUMBER_DIGITS = /206[\s).-]*442[\s.-]*0188|2064420188/;

const property = {
  id: "prop-1",
  title: "4709A 8th Ave NE",
  address: "4709A 8th Ave NE, Seattle, WA 98105",
  contactSmsPhone: NUMBER,
  contactWorkEmail: "leasing@example.com",
  listingSubmission: {
    v: 1,
    shortTermRentalsAllowed: true,
    shortTermDailyCost: "80",
    rooms: [
      { id: "r1", name: "Room 1", occupancyCapacity: 1, monthlyRent: "1000" },
      { id: "r2", name: "Room 2", occupancyCapacity: 1, monthlyRent: "1200" },
    ],
  },
} as unknown as MockProperty;

const rich: ListingRichContent = {
  heroTagline: "",
  heroHousePhotoUrls: [],
  priceRangeLabel: "From $1,000/mo",
  startingRentLabel: "$1,000/mo",
  pricingBreakdown: [],
  floorPlans: [],
  bathrooms: [],
  sharedSpaces: [],
  leaseBasics: [],
  amenities: [],
  bundlesText: "",
  bundleCards: [],
  quickFacts: [],
};

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ rooms: [] }), { status: 200 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  route.pathname = "/rent/listings/prop-1";
});

const noTextAnywhere = () => {
  expect(document.querySelector('a[href^="sms:"], a[href^="tel:"]')).toBeNull();
  expect(document.body.textContent).not.toMatch(NUMBER_DIGITS);
  expect(document.body.textContent).not.toMatch(/Text us|Text to apply|Text a message|Text for bundle/);
};

describe("a /rent listing is the web channel", () => {
  it("draws no number, text link or prefilled message on either segment, in the card or the phone dock", () => {
    render(
      <PublicTextingProvider value={{ phone: "+12066781909", smsHref: "sms:+12066781909" }}>
        <ListingDetailSections property={property} rich={rich} phoneDock />
      </PublicTextingProvider>,
    );
    noTextAnywhere();
    const short = document.querySelector('[data-attr="listing-stay-short"]') as HTMLElement | null;
    short?.click();
    noTextAnywhere();
  });

  it("sends a signed-out visitor's Book a tour and Apply through resident sign-up into the portal", () => {
    render(<ListingDetailSections property={property} rich={rich} />);
    for (const attr of ["listing-web-tour", "listing-web-apply"]) {
      const href = document.querySelector(`[data-attr="${attr}"]`)!.getAttribute("href")!;
      expect(href.startsWith("/auth/create-account?mode=create&role=resident&next=")).toBe(true);
      expect(decodeURIComponent(href.split("next=")[1]!)).toMatch(/^\/resident\//);
    }
  });

  it("keeps the source free of text links: no sms:/tel:, no prefilled drafts, no public texting number", () => {
    const files = [
      ...walk("src/app/(public)/rent"),
      ...[
        "application-unavailable-contact-manager",
        "public-listing-page-client",
        "rent-browse-page-client",
        "rental-application-wizard",
        "resident-housing-browse",
        "short-stay-booking",
        "tour-schedule-flow",
        "workspace-browse-page-client",
        "prospect-listing-cta",
      ].map((name) => `src/components/marketing/${name}.tsx`),
      ...readdirSync("src/components/marketing").filter((f) => /^listing-.*\.tsx$/.test(f)).map((f) => `src/components/marketing/${f}`),
    ];
    const offenders = files.filter((file) => /sms:|tel:|buildSmsDeepLink|usePublicTexting|formatSmsPhoneLabel|renterSmsHref|formatPublicPhone/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
  });
});

describe("the public footer and menu number", () => {
  it("is hidden on every /rent path and kept elsewhere", () => {
    expect(["/rent", "/rent/browse", "/rent/listings/x", "/rent/apply"].every(isRentPath)).toBe(true);
    expect(["/", "/about", "/rental", "/blog"].some(isRentPath)).toBe(false);
    const { container, rerender } = render(<FooterTextNumber phone="(206) 678-1909" smsHref="sms:+12066781909" />);
    expect(container.textContent).toBe("");
    route.pathname = "/about";
    rerender(<FooterTextNumber phone="(206) 678-1909" smsHref="sms:+12066781909" />);
    expect(container.querySelector('a[href="sms:+12066781909"]')).not.toBeNull();
  });
});

describe("the anonymous booking route", () => {
  it("is retired: 410 with the portal sign-in and create-account doors, and it writes nothing", async () => {
    const res = await retiredShortStayRequest();
    expect(res.status).toBe(410);
    const body = (await res.json()) as { signIn: string; createAccount: string };
    expect(decodeURIComponent(body.createAccount)).toContain("role=resident&next=/resident/stays/request");
    expect(decodeURIComponent(body.signIn)).toContain("next=/resident/stays/request");
    expect(readFileSync("src/app/api/public/short-stay-request/route.ts", "utf8")).not.toMatch(/createSupabase|submitShortStayRequest|ensureGuestLogin/);
  });
});

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return walk(path);
    return /\.tsx?$/.test(name) ? [path] : [];
  });
}
