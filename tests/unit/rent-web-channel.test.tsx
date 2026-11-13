// @vitest-environment jsdom
/**
 * Web vs Messages (captain, Oct 20, rewritten Nov 12 for design-1112 §5.1): everything under /rent is still the web
 * channel for Tour, Book, tours and apply (a resident account, never a number). The ONE exception is the listing's
 * own Message and Text us: Message needs only a phone and a texted code, and Text us is an `sms:` link to the single
 * configured PropLane line (`getPublicTextingConfig()`, never a literal) and nothing else. A /rent page never carries
 * any other number, never a `tel:` link, and `sms:` appears only on the Text us control. The homepage keeps its number.
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

const LINE = "+12066781909";
const LINE_DIGITS = /206[\s).-]*678[\s.-]*1909|2066781909/;

/** Every phone number a /rent page may carry is the configured line, and only inside a Text us control. */
const onlyTheLineInTextUs = () => {
  expect(document.querySelector('a[href^="tel:"]')).toBeNull();
  const smsLinks = [...document.querySelectorAll('a[href^="sms:"]')];
  expect(smsLinks.length).toBeGreaterThan(0);
  for (const link of smsLinks) {
    expect(link.getAttribute("href")!.startsWith(`sms:${LINE}?&body=`)).toBe(true);
    expect(link.getAttribute("data-attr")).toMatch(/text-us$/);
  }
  expect(document.body.textContent).not.toMatch(NUMBER_DIGITS);
  expect(document.body.textContent).not.toMatch(LINE_DIGITS);
  expect(document.body.textContent).not.toMatch(/Text to apply|Text a message|Text for bundle/);
};

describe("a /rent listing is the web channel, with Message and Text us", () => {
  it("draws Message and Text us in the card and the phone dock; the only number is the configured line, only in Text us", () => {
    render(
      <PublicTextingProvider value={{ phone: LINE, smsHref: `sms:${LINE}` }}>
        <ListingDetailSections property={property} rich={rich} phoneDock />
      </PublicTextingProvider>,
    );
    for (const root of [document.querySelector('[data-attr="listing-price-card"]')!, document.querySelector('[data-attr="listing-sticky-bar"]')!]) {
      expect(root.querySelector('[data-attr="listing-message"]')).not.toBeNull();
      expect(root.querySelector('[data-attr="listing-text-us"]')).not.toBeNull();
    }
    onlyTheLineInTextUs();
  });

  it("draws Message but no Text us, no number and no sms: link when no line is configured", () => {
    render(<ListingDetailSections property={property} rich={rich} phoneDock />);
    expect(document.querySelector('[data-attr="listing-message"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="listing-text-us"]')).toBeNull();
    expect(document.querySelector('a[href^="sms:"], a[href^="tel:"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(NUMBER_DIGITS);
    expect(document.body.textContent).not.toMatch(LINE_DIGITS);
  });

  it("never offers a message or a text from a manager's own preview", () => {
    render(
      <PublicTextingProvider value={{ phone: LINE, smsHref: `sms:${LINE}` }}>
        <ListingDetailSections property={property} rich={rich} portalEmbedded />
      </PublicTextingProvider>,
    );
    expect(document.querySelector('[data-attr="listing-message"], [data-attr="listing-text-us"]')).toBeNull();
    expect(document.querySelector('a[href^="sms:"]')).toBeNull();
  });

  it("sends a signed-out visitor's Tour and Book through resident sign-up into the portal", () => {
    render(<ListingDetailSections property={property} rich={rich} />);
    for (const attr of ["listing-web-tour", "listing-web-apply"]) {
      const href = document.querySelector(`[data-attr="${attr}"]`)!.getAttribute("href")!;
      expect(href.startsWith("/auth/create-account?mode=create&role=resident&next=")).toBe(true);
      expect(decodeURIComponent(href.split("next=")[1]!)).toMatch(/^\/resident\//);
    }
  });

  it("keeps the source free of text links: tel: nowhere, sms: and the texting context only in the Message sheet's Text us", () => {
    const files = [
      ...walk("src/app/(rent)/rent"),
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
    const TEXT_US_HOME = "src/components/marketing/listing-message-sheet.tsx";
    const offenders = files
      .filter((file) => file !== TEXT_US_HOME)
      .filter((file) => /sms:|tel:|buildSmsDeepLink|usePublicTexting|formatSmsPhoneLabel|renterSmsHref|formatPublicPhone/.test(readFileSync(file, "utf8")));
    expect(offenders).toEqual([]);
    // The one home of Text us builds its link from the configured line through the pure helper, never a literal.
    const home = readFileSync(TEXT_US_HOME, "utf8");
    expect(home).toMatch(/textUsHref\(phone,/);
    expect(home).not.toMatch(/tel:|\+1\d{10}|206[\s).-]*678/);
    expect(readFileSync("src/lib/personal-link/text-us.ts", "utf8")).not.toMatch(/\+1\d{10}|206[\s).-]*678/);
  });
});

describe("the /rent pages keep their CDN caching", () => {
  it("the layout reads only the cached public texting snapshot (no cookies, headers or dynamic opt-in), and the listing keeps its ISR window", () => {
    const layout = readFileSync("src/app/(rent)/layout.tsx", "utf8");
    expect(layout).not.toMatch(/next\/headers|cookies\(|headers\(|force-dynamic|unstable_noStore|revalidate\s*=\s*0/);
    expect(readFileSync("src/app/(rent)/rent/listings/[id]/page.tsx", "utf8")).toMatch(/export const revalidate = 3600/);
    // The Message and Text us client code reads nothing at render: the entry code is fetched on the client after paint.
    expect(readFileSync("src/components/marketing/listing-message-sheet.tsx", "utf8")).not.toMatch(/next\/headers|force-dynamic/);
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
    expect(decodeURIComponent(body.createAccount)).toContain("role=resident&next=/resident/applications/stay");
    expect(decodeURIComponent(body.signIn)).toContain("next=/resident/applications/stay");
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
