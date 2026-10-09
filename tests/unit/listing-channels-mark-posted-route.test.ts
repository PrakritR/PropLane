import { beforeEach, describe, expect, it, vi } from "vitest";

import { isMissingColumnError } from "@/lib/db-missing-column";

type Upsert = { values: Record<string, unknown>; onConflict?: string };

const h = vi.hoisted(() => ({
  ctx: null as null | { db: unknown; userId: string; workspace: { id: string; ownerUserId: string; owned: boolean } },
  owned: null as null | { id: string; live: boolean },
  upserts: [] as Upsert[],
  errors: [] as ({ code?: string; message: string } | null)[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/listing-channels/route-context.server", () => ({
  resolveListingChannelContext: async () => h.ctx,
  propertyInWorkspace: async () => h.owned,
}));

import { POST } from "@/app/api/manager/listing-channels/mark-posted/route";

const db = {
  from: () => ({
    upsert: async (values: Record<string, unknown>, opts?: { onConflict?: string }) => {
      h.upserts.push({ values, onConflict: opts?.onConflict });
      return { error: h.errors.shift() ?? null };
    },
  }),
};

const post = (body: Record<string, unknown>) =>
  POST(new Request("https://proplane.ai/api/manager/listing-channels/mark-posted", { method: "POST", body: JSON.stringify(body) }));

describe("mark-posted route", () => {
  beforeEach(() => {
    h.ctx = { db, userId: "u", workspace: { id: "w", ownerUserId: "u", owned: true } };
    h.owned = { id: "p1", live: true };
    h.upserts = [];
    h.errors = [];
  });

  it("refuses a workspace member who is not the owner", async () => {
    h.ctx = { db, userId: "u2", workspace: { id: "w", ownerUserId: "u", owned: false } };
    expect((await post({ propertyId: "p1", channel: "craigslist", posted: true })).status).toBe(403);
    expect(h.upserts).toHaveLength(0);
  });

  it("stores the ad link the manager gave", async () => {
    expect((await post({ propertyId: "p1", channel: "craigslist", posted: true, postedUrl: "https://craigslist.org/ad/1" })).status).toBe(200);
    expect(h.upserts[0]!.values).toMatchObject({ state: "posted_by_me", posted_url: "https://craigslist.org/ad/1" });
  });

  it("leaves the column untouched on a mark with no link, and clears it on undo", async () => {
    await post({ propertyId: "p1", channel: "craigslist", posted: true });
    expect(h.upserts[0]!.values).not.toHaveProperty("posted_url");
    await post({ propertyId: "p1", channel: "craigslist", posted: false });
    expect(h.upserts[1]!.values).toMatchObject({ state: "off", posted_url: null });
  });

  it("refuses an ad link that is not a full https address", async () => {
    expect((await post({ propertyId: "p1", channel: "craigslist", posted: true, postedUrl: "javascript:alert(1)" })).status).toBe(400);
    expect((await post({ propertyId: "p1", channel: "craigslist", posted: true, postedUrl: "http://craigslist.org/ad/1" })).status).toBe(400);
    expect(h.upserts).toHaveLength(0);
  });

  it("still records the post when posted_url is not migrated yet", async () => {
    h.errors = [{ code: "42703", message: 'column "posted_url" of relation "listing_channel_posts" does not exist' }, null];
    const res = await post({ propertyId: "p1", channel: "craigslist", posted: true, postedUrl: "https://craigslist.org/ad/1" });
    expect(res.status).toBe(200);
    expect(h.upserts).toHaveLength(2);
    expect(h.upserts[1]!.values).not.toHaveProperty("posted_url");
    expect(h.upserts[1]!.values).toMatchObject({ state: "posted_by_me" });
  });

  it("reports any other write failure instead of retrying", async () => {
    h.errors = [{ code: "23505", message: "duplicate key" }];
    expect((await post({ propertyId: "p1", channel: "craigslist", posted: true, postedUrl: "https://craigslist.org/ad/1" })).status).toBe(500);
    expect(h.upserts).toHaveLength(1);
  });
});

describe("isMissingColumnError", () => {
  it("recognizes the column-not-there shapes and nothing else", () => {
    expect(isMissingColumnError({ code: "42703", message: "whatever" }, "posted_url")).toBe(true);
    expect(isMissingColumnError({ code: "PGRST204", message: "Could not find the 'source_channel' column" }, "source_channel")).toBe(true);
    expect(isMissingColumnError(new Error('Could not persist: column "source_channel" does not exist'), "source_channel")).toBe(true);
    expect(isMissingColumnError({ code: "PGRST204", message: "Could not find the 'other' column" }, "source_channel")).toBe(false);
    expect(isMissingColumnError({ code: "23505", message: "duplicate key" }, "posted_url")).toBe(false);
    expect(isMissingColumnError(null, "posted_url")).toBe(false);
  });
});
