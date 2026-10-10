import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  ctx: null as null | { db: object; userId: string; workspace: { id: string; ownerUserId: string; propertyIds: string[] } },
  owned: null as null | { id: string; live: boolean },
  photos: [] as string[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/listing-channels/route-context.server", () => ({
  resolveListingChannelContext: async () => h.ctx,
  propertyInWorkspace: async () => h.owned,
}));
vi.mock("@/lib/listing-channels/sync.server", () => ({
  loadSyncListing: async () => ({ propertyId: "p1", projected: { title: "Maple House" } }),
}));
vi.mock("@/lib/listing-channels/post-text", () => ({ listingPostPhotoUrls: () => h.photos }));

import { GET, maxDuration } from "@/app/api/manager/listing-channels/photos/route";
import { isAllowedPhotoUrl } from "@/lib/listing-channels/photo-hosts";

const req = (q = "?propertyId=p1") => new Request(`https://proplane.ai/api/manager/listing-channels/photos${q}`);

/** The STORE zip keeps entry names verbatim, so they read straight back out of the bytes. */
async function zipNames(res: Response): Promise<string[]> {
  const text = new TextDecoder().decode(new Uint8Array(await res.arrayBuffer()));
  return [...new Set(text.match(/photo-\d\d\.[a-z]+/g) ?? [])];
}

describe("photos route", () => {
  beforeEach(() => {
    h.ctx = null;
    h.owned = null;
    h.photos = [];
    process.env.NEXT_PUBLIC_SUPABASE_URL = "https://proj.supabase.co";
    vi.restoreAllMocks();
  });

  it("is 401 when unauthenticated", async () => {
    expect((await GET(req())).status).toBe(401);
  });

  it("is 404 for a listing outside the manager's workspace", async () => {
    h.ctx = { db: {}, userId: "u", workspace: { id: "w", ownerUserId: "u", propertyIds: [] } };
    h.owned = null;
    expect((await GET(req())).status).toBe(404);
  });

  it("refuses foreign photo hosts and never fetches them", async () => {
    h.ctx = { db: {}, userId: "u", workspace: { id: "w", ownerUserId: "u", propertyIds: ["p1"] } };
    h.owned = { id: "p1", live: true };
    h.photos = ["https://evil.example/a.jpg", "http://proj.supabase.co/a.jpg", "https://169.254.169.254/x.jpg"];
    const spy = vi.spyOn(globalThis, "fetch");
    const res = await GET(req());
    expect(res.status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });

  it("streams a zip for allowed photos, labelled partial because the foreign-host photo is missing", async () => {
    h.ctx = { db: {}, userId: "u", workspace: { id: "w", ownerUserId: "u", propertyIds: ["p1"] } };
    h.owned = { id: "p1", live: true };
    h.photos = ["https://proj.supabase.co/storage/v1/object/public/x/a.jpg", "https://evil.example/b.jpg"];
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    // 1 of the listing's 2 photos: a host this route will not read is still a photo the ad is missing.
    expect(res.headers.get("x-photos-partial")).toBe("1/2");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="maple-house-photos-partial.zip"');
    expect(res.headers.get("content-type")).toBe("application/zip");
  });

  it("fetches sequentially and stops at the total cap", async () => {
    h.ctx = { db: {}, userId: "u", workspace: { id: "w", ownerUserId: "u", propertyIds: ["p1"] } };
    h.owned = { id: "p1", live: true };
    h.photos = Array.from({ length: 4 }, (_, i) => `https://proj.supabase.co/storage/v1/object/public/x/${i}.jpg`);
    const order: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      order.push(String(input));
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return new Response(new Uint8Array(8));
    });
    expect((await GET(req())).status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(4);
    expect(maxInFlight).toBe(1);
    expect(order).toEqual(h.photos);
  });

  it("drops a body that runs past the per-photo cap even with no Content-Length", async () => {
    h.ctx = { db: {}, userId: "u", workspace: { id: "w", ownerUserId: "u", propertyIds: ["p1"] } };
    h.owned = { id: "p1", live: true };
    h.photos = ["https://proj.supabase.co/storage/v1/object/public/x/big.jpg"];
    let pushed = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pushed += 1;
          // 32 x 1 MiB would be 32 MiB: the read must abort past the 15 MiB cap.
          if (pushed > 32) return controller.close();
          controller.enqueue(new Uint8Array(1024 * 1024));
        },
      });
      return new Response(body);
    });
    const res = await GET(req());
    expect(res.status).toBe(502);
    expect(pushed).toBeLessThan(32);
  });

  it("declares a function budget the sequential loop fits inside", () => {
    expect(maxDuration).toBe(60);
  });

  it("ships the photos it already has once the deadline passes", async () => {
    h.ctx = { db: {}, userId: "u", workspace: { id: "w", ownerUserId: "u", propertyIds: ["p1"] } };
    h.owned = { id: "p1", live: true };
    h.photos = Array.from({ length: 5 }, (_, i) => `https://proj.supabase.co/storage/v1/object/public/x/${i}.jpg`);
    let clock = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => clock);
    // Each photo "takes" 21 s, so the third one is past the 40 s deadline.
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      clock += 21_000;
      return new Response(new Uint8Array([1, 2, 3]));
    });
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(res.headers.get("x-photos-partial")).toBe("2/5");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="maple-house-photos-partial.zip"');
  });

  it("a complete zip carries no partial marker", async () => {
    h.ctx = { db: {}, userId: "u", workspace: { id: "w", ownerUserId: "u", propertyIds: ["p1"] } };
    h.owned = { id: "p1", live: true };
    h.photos = ["https://proj.supabase.co/storage/v1/object/public/x/a.jpg", "https://proj.supabase.co/storage/v1/object/public/x/b.jpg"];
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(new Uint8Array([1, 2, 3])));
    const res = await GET(req());
    expect(res.headers.get("x-photos-partial")).toBeNull();
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="maple-house-photos.zip"');
    expect(await zipNames(res)).toEqual(["photo-01.jpg", "photo-02.jpg"]);
  });

  it("keeps each photo's own number so a skipped one leaves a visible gap", async () => {
    h.ctx = { db: {}, userId: "u", workspace: { id: "w", ownerUserId: "u", propertyIds: ["p1"] } };
    h.owned = { id: "p1", live: true };
    h.photos = ["a", "b", "c"].map((n) => `https://proj.supabase.co/storage/v1/object/public/x/${n}.jpg`);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) =>
      String(input).endsWith("b.jpg") ? new Response("gone", { status: 404 }) : new Response(new Uint8Array([1, 2, 3])),
    );
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(await zipNames(res)).toEqual(["photo-01.jpg", "photo-03.jpg"]);
    expect(res.headers.get("x-photos-partial")).toBe("2/3");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="maple-house-photos-partial.zip"');
  });

  it("host allowlist helper", () => {
    const hosts = new Set(["proj.supabase.co"]);
    expect(isAllowedPhotoUrl("https://proj.supabase.co/a.jpg", hosts)).toBe(true);
    expect(isAllowedPhotoUrl("https://proj.supabase.co.evil.com/a.jpg", hosts)).toBe(false);
    expect(isAllowedPhotoUrl("https://user:pw@proj.supabase.co/a.jpg", hosts)).toBe(false);
    expect(isAllowedPhotoUrl("http://proj.supabase.co/a.jpg", hosts)).toBe(false);
    expect(isAllowedPhotoUrl("not a url", hosts)).toBe(false);
  });
});
