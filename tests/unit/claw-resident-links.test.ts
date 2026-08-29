import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
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

  it("prefers CLAW_MESSENGER_LINK_ORIGIN over localhost app url", () => {
    process.env.NEXT_PUBLIC_APP_URL = "http://localhost:3000";
    process.env.CLAW_MESSENGER_LINK_ORIGIN = "https://www.axis-seattle-housing.com";
    expect(residentSmsLinkOrigin()).toBe("https://www.axis-seattle-housing.com");
    expect(residentPortalUrl("payments")).toBe(
      "https://www.axis-seattle-housing.com/resident/payments/pending",
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
 * Route existence
 * ------------------------------------------------------------------ */

const APP_DIR = resolve(__dirname, "../../src/app");

const OPTIONAL_CATCH_ALL = /^\[\[\.{3}.+\]\]$/;
const CATCH_ALL = /^\[\.{3}.+\]$/;
const DYNAMIC = /^\[(?!\[|\.{3}).+\]$/;
const ROUTE_GROUP = /^\(.+\)$/;

function childDirs(dir: string): string[] {
  try {
    return readdirSync(dir).filter((e) => statSync(join(dir, e)).isDirectory());
  } catch {
    return [];
  }
}

function hasPage(dir: string): boolean {
  try {
    return readdirSync(dir).some((f) => /^(page|route)\.(t|j)sx?$/.test(f));
  } catch {
    return false;
  }
}

/**
 * True when the app router can resolve `pathname` to a page or route handler.
 *
 * Models the four things that decide it: literal segments, `[dynamic]` ones,
 * `[...catchAll]` / `[[...optional]]` (the optional form matches ZERO segments,
 * which is how `/portal/properties` resolves through
 * `portal/[section]/[[...tab]]/page.tsx` even though `portal/properties/` holds
 * only `[stage]/`), and `(group)` directories, which are invisible in the URL.
 */
function routeResolves(pathname: string, dir = APP_DIR): boolean {
  const path = pathname.split("?")[0] ?? "/";
  const segments = path.split("/").filter(Boolean);
  const children = childDirs(dir);

  if (segments.length === 0) {
    if (hasPage(dir)) return true;
    // An optional catch-all also matches no segments at all.
    if (children.some((c) => OPTIONAL_CATCH_ALL.test(c) && hasPage(join(dir, c)))) return true;
    return children.some((c) => ROUTE_GROUP.test(c) && routeResolves("/", join(dir, c)));
  }

  const [head, ...rest] = segments;
  const restPath = `/${rest.join("/")}`;
  const ordered = [
    ...children.filter((c) => c === head),
    ...children.filter((c) => DYNAMIC.test(c)),
    ...children.filter((c) => CATCH_ALL.test(c) || OPTIONAL_CATCH_ALL.test(c)),
  ];
  for (const candidate of ordered) {
    const next = join(dir, candidate);
    // Either catch-all form swallows every remaining segment.
    if ((CATCH_ALL.test(candidate) || OPTIONAL_CATCH_ALL.test(candidate)) && hasPage(next)) return true;
    if (routeResolves(restPath, next)) return true;
  }
  // Route groups do not consume a segment.
  return children.some((c) => ROUTE_GROUP.test(c) && routeResolves(path, join(dir, c)));
}

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
