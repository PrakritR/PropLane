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

import { GET } from "@/app/api/manager/listing-channels/photos/route";
import { isAllowedPhotoUrl } from "@/lib/listing-channels/photo-hosts";

const req = (q = "?propertyId=p1") => new Request(`https://proplane.ai/api/manager/listing-channels/photos${q}`);

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

  it("streams a zip for allowed photos", async () => {
    h.ctx = { db: {}, userId: "u", workspace: { id: "w", ownerUserId: "u", propertyIds: ["p1"] } };
    h.owned = { id: "p1", live: true };
    h.photos = ["https://proj.supabase.co/storage/v1/object/public/x/a.jpg", "https://evil.example/b.jpg"];
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Uint8Array([1, 2, 3])));
    const res = await GET(req());
    expect(res.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="maple-house-photos.zip"');
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

  it("host allowlist helper", () => {
    const hosts = new Set(["proj.supabase.co"]);
    expect(isAllowedPhotoUrl("https://proj.supabase.co/a.jpg", hosts)).toBe(true);
    expect(isAllowedPhotoUrl("https://proj.supabase.co.evil.com/a.jpg", hosts)).toBe(false);
    expect(isAllowedPhotoUrl("https://user:pw@proj.supabase.co/a.jpg", hosts)).toBe(false);
    expect(isAllowedPhotoUrl("http://proj.supabase.co/a.jpg", hosts)).toBe(false);
    expect(isAllowedPhotoUrl("not a url", hosts)).toBe(false);
  });
});
