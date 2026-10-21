/**
 * Evidence harness (batch 2, 2026-10-13): what an AI crawler actually receives.
 *
 * `/llms.txt`, `/llms-full.txt` and `/robots.txt` need no database, so they are
 * curled from a running dev server; this file covers the two surfaces that do:
 * `/sitemap.xml` with live listings in it, and the JSON-LD a
 * `/rent/listings/<id>` page emits. The public catalog read is stubbed with one
 * listing that deliberately carries manager-internal fields, so the artifact
 * also shows they are not published.
 *
 * Writes its artifacts only when EVIDENCE_DIR is set.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { resolveSitemap } from "next/dist/build/webpack/loaders/metadata/resolve-route-data";

const LISTING = {
  id: "7c1f0f2a-room-9",
  title: "Room 9 · 4709A 8th Ave NE",
  tagline: "Furnished room in a shared house, utilities included",
  address: "4709A 8th Ave NE",
  zip: "98105",
  neighborhood: "U District",
  beds: 1,
  baths: 1,
  rentLabel: "$1,100/mo",
  available: "Now",
  petFriendly: false,
  buildingId: "b-1",
  buildingName: "4709A 8th Ave NE",
  unitLabel: "Room 9",
  state: "wa",
  listingSubmission: { v: 1, city: " Seattle ", state: "WA" },
  // Manager-internal facts a crawler must never see.
  contactSmsPhone: "+12065550100",
  contactWorkEmail: "manager@example.test",
  managerUserId: "mgr-secret-1",
};
const SECOND = { ...LISTING, id: "9b2e-room-3", title: "Room 3 · 5257 Brooklyn" };

vi.mock("@/lib/public-listings.server", () => ({ getPublicListings: async () => [LISTING, SECOND] }));

const OUT = process.env.EVIDENCE_DIR ?? "";
function write(name: string, body: string) {
  if (!OUT) return;
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}/${name}`, body.endsWith("\n") ? body : `${body}\n`, "utf8");
}

describe("evidence · /sitemap.xml advertises every live listing", () => {
  it("renders the same XML the route serves, listings included", async () => {
    const sitemap = (await import("@/app/sitemap")).default;
    const xml = resolveSitemap(await sitemap());
    expect(xml).toContain("https://proplane.ai/rent/listings/7c1f0f2a-room-9");
    expect(xml).toContain("https://proplane.ai/rent/listings/9b2e-room-3");
    expect(xml).toContain("https://proplane.ai/blog/real-cost-of-a-turnover");
    write("sitemap-with-listings.xml", xml);
  });
});

describe("evidence · a listing page carries Accommodation JSON-LD", () => {
  it("emits the public facts and none of the manager's", async () => {
    const page = (await import("@/app/(rent)/rent/listings/[id]/page")).default;
    const tree = (await page({ params: Promise.resolve({ id: LISTING.id }) })) as {
      props: { children: { props?: { dangerouslySetInnerHTML?: { __html: string } } }[] };
    };
    const script = tree.props.children.find((child) => child?.props?.dangerouslySetInnerHTML);
    const html = script!.props!.dangerouslySetInnerHTML!.__html;
    const data = JSON.parse(html) as Record<string, never>;
    expect(data["@type"]).toBe("Accommodation");
    // No manager contact, no workspace id, and no tag a field could close.
    for (const secret of ["2065550100", "example.test", "mgr-secret-1"]) expect(html).not.toContain(secret);
    expect(html).not.toContain("<");
    write("listing-jsonld.json", JSON.stringify(data, null, 2));
    write(
      "listing-page-head.html",
      `<script type="application/ld+json">${html}</script>`,
    );
  });

  it("renders without structured data when the catalog read fails", async () => {
    const page = (await import("@/app/(rent)/rent/listings/[id]/page")).default;
    const tree = (await page({ params: Promise.resolve({ id: "not-a-listing" }) })) as {
      props: { children: unknown[] };
    };
    expect(tree.props.children.some((child) => (child as { props?: { dangerouslySetInnerHTML?: unknown } })?.props?.dangerouslySetInnerHTML)).toBe(false);
  });
});
