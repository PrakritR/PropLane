// "Send me photos of that house" on the shared line: up to two real https photos as MMS from the PropLane
// line, only to the texting phone, only on the shared line, never a placeholder.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { storedListing } from "../helpers/lead-listing-fixtures";
import { linksFakeDb } from "../helpers/links-fake-db";

const mocks = vi.hoisted(() => ({ listing: vi.fn(), catalog: vi.fn(), sent: [] as Array<Record<string, unknown>>, sendOk: true }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/tools/domains/leasing-sms", () => ({ resolveLiveListingForSms: mocks.listing }));
vi.mock("@/lib/seo/public-catalog.server", () => ({ getCrawlPublicListings: mocks.catalog }));
vi.mock("@/lib/one-number/send.server", () => ({
  sendSharedLineMessage: vi.fn(async (_db: unknown, send: Record<string, unknown>) => {
    mocks.sent.push(send);
    return mocks.sendOk ? { ok: true, messageSid: "SM1", segments: 1 } : { ok: false, reason: "opted_out" };
  }),
}));

import { leasingSendListingPhotosTool, listingPhotoUrls } from "@/lib/tools/domains/one-number-photos";
import { withSharedLineTools } from "@/lib/tools/domains/one-number-links";

const WS = "ws-a";
const world = (mode: "shared" | "per_workspace" = "shared") =>
  linksFakeDb({
    sms_runtime_config: [{ singleton: true, line_mode: mode, shared_number_e164: "+12065550100", shared_pilot_workspace_ids: [] }],
    portal_workspaces: [{ id: WS, owner_user_id: "owner-a", is_default: true }],
    manager_property_records: [{ id: "prop-1", workspace_id: WS, manager_user_id: "owner-a" }],
  });
const ctx = (db: never, over: Record<string, unknown> = {}) =>
  ({ landlordId: "owner-a", userId: "owner-a", email: "", roles: [], isAdmin: false, db, leasingScope: { sessionId: "s1", prospectPhoneE164: "+12065550155", channel: "sms" }, ...over }) as never;

beforeEach(() => {
  mocks.sent.length = 0;
  mocks.sendOk = true;
  mocks.listing.mockReset().mockResolvedValue("prop-1");
  mocks.catalog.mockReset();
});

describe("listingPhotoUrls", () => {
  it("returns at most two distinct real https photos", () => {
    const listing = storedListing("prop-1", { manager: "m", neighborhood: "Ballard", beds: 3, rent: 800, street: "9 Market St", photo: "https://cdn.example.com/a.jpg" });
    const urls = listingPhotoUrls(listing);
    expect(urls.length).toBeLessThanOrEqual(2);
    expect(urls.every((u) => u.startsWith("https://"))).toBe(true);
  });

  it("returns nothing for a listing with no photo, never a placeholder", () => {
    expect(listingPhotoUrls(storedListing("prop-2", { manager: "m", neighborhood: "Ballard", beds: 3, rent: 800, street: "9 Market St" }))).toEqual([]);
  });
});

describe("send_listing_photos", () => {
  it("texts the photos to the texting phone from the shared line and says how many", async () => {
    const { db } = world();
    mocks.catalog.mockResolvedValue([storedListing("prop-1", { manager: "owner-a", neighborhood: "Ballard", beds: 3, rent: 800, street: "9 Market St", name: "Ballard House", photo: "https://cdn.example.com/a.jpg" })]);
    const result = await leasingSendListingPhotosTool.handler(ctx(db), { propertyId: "prop-1" });
    expect(result).toMatchObject({ ok: true, listing: "Ballard House" });
    expect(mocks.sent).toHaveLength(1);
    expect(mocks.sent[0]).toMatchObject({
      workspaceId: WS, ownerUserId: "owner-a", toPhone: "+12065550155", role: "prospect", body: "Photos of Ballard House",
      mediaUrls: ["https://cdn.example.com/a.jpg"],
    });
    expect(String(mocks.sent[0]!.idempotencyKey)).toMatch(/^listing-photos:s1:prop-1:\d+$/);
  });

  it("says so when the listing has no photo and sends nothing", async () => {
    const { db } = world();
    mocks.catalog.mockResolvedValue([storedListing("prop-1", { manager: "owner-a", neighborhood: "Ballard", beds: 3, rent: 800, street: "9 Market St" })]);
    expect(await leasingSendListingPhotosTool.handler(ctx(db), { propertyId: "prop-1" })).toEqual({ ok: false, error: "no_photos" });
    expect(mocks.sent).toHaveLength(0);
  });

  it("reports a refused send (opted out, quiet hours, no credit) instead of claiming it went", async () => {
    const { db } = world();
    mocks.sendOk = false;
    mocks.catalog.mockResolvedValue([storedListing("prop-1", { manager: "owner-a", neighborhood: "Ballard", beds: 3, rent: 800, street: "9 Market St", photo: "https://cdn.example.com/a.jpg" })]);
    expect(await leasingSendListingPhotosTool.handler(ctx(db), { propertyId: "prop-1" })).toEqual({ ok: false, error: "send_failed" });
  });

  it("does nothing off the shared line, off SMS, unscoped, or for a listing it cannot resolve", async () => {
    mocks.catalog.mockResolvedValue([storedListing("prop-1", { manager: "owner-a", neighborhood: "Ballard", beds: 3, rent: 800, street: "9 Market St", photo: "https://cdn.example.com/a.jpg" })]);
    expect(await leasingSendListingPhotosTool.handler(ctx(world("per_workspace").db as never), { propertyId: "prop-1" })).toEqual({ ok: false, error: "photos_unavailable" });
    const { db } = world();
    expect(await leasingSendListingPhotosTool.handler(ctx(db, { leasingScope: { sessionId: "s", prospectPhoneE164: "+12065550155", channel: "email" } }), { propertyId: "prop-1" })).toEqual({ ok: false, error: "photos_unavailable" });
    expect(await leasingSendListingPhotosTool.handler(ctx(db, { leasingScope: undefined }), { propertyId: "prop-1" })).toEqual({ ok: false, error: "photos_unavailable" });
    mocks.listing.mockResolvedValue(null);
    expect(await leasingSendListingPhotosTool.handler(ctx(db), { propertyId: "nope" })).toEqual({ ok: false, error: "not_found" });
    expect(mocks.sent).toHaveLength(0);
  });

  it("takes no phone or workspace from the model", () => {
    expect(leasingSendListingPhotosTool.inputSchema.safeParse({ propertyId: "p", phone: "2065550100" }).success).toBe(false);
    expect(leasingSendListingPhotosTool.inputSchema.safeParse({ propertyId: "p", workspaceId: WS }).success).toBe(false);
  });

  it("is added to a registry only while the line is shared", async () => {
    const registry = new Map() as never;
    expect((await withSharedLineTools(world("shared").db as never, registry, [leasingSendListingPhotosTool as never])).has("send_listing_photos")).toBe(true);
    expect((await withSharedLineTools(world("per_workspace").db as never, registry, [leasingSendListingPhotosTool as never])).size).toBe(0);
  });
});
