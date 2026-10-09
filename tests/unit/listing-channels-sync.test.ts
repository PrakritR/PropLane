import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { MockProperty } from "@/data/types";

type Row = Record<string, unknown>;

/** A tiny in-memory PostgREST stand-in: just the chain the sync module uses. */
function fakeDb(seed: { posts?: Row[]; properties?: Row[] }) {
  const tables: Record<string, Row[]> = { listing_channel_posts: [...(seed.posts ?? [])], manager_property_records: [...(seed.properties ?? [])] };
  let counter = 0;
  const db = {
    tables,
    from(name: string) {
      const filters: ((r: Row) => boolean)[] = [];
      let op: "select" | "update" | "upsert" | "delete" = "select";
      let payload: Row = {};
      let onConflict = "";
      let max = Infinity;
      const rows = () => (tables[name] ??= []);
      const matched = () => rows().filter((r) => filters.every((f) => f(r))).slice(0, max);
      const run = () => {
        if (op === "update") {
          const hit = matched();
          for (const r of hit) Object.assign(r, payload);
          return { data: hit, error: null };
        }
        if (op === "delete") {
          const hit = matched();
          tables[name] = rows().filter((r) => !hit.includes(r));
          return { data: hit, error: null };
        }
        if (op === "upsert") {
          const keys = onConflict.split(",");
          const existing = rows().find((r) => keys.every((k) => r[k] === payload[k]));
          if (existing) Object.assign(existing, payload);
          else rows().push({ id: `row-${++counter}`, enabled: true, state: "pending", pending_action: null, attempts: 0, ...payload });
          return { data: null, error: null };
        }
        return { data: matched(), error: null };
      };
      const b: Record<string, unknown> = {
        select: () => b,
        update: (p: Row) => ((op = "update"), (payload = p), b),
        upsert: (p: Row, o: { onConflict: string }) => ((op = "upsert"), (payload = p), (onConflict = o.onConflict), b),
        delete: () => ((op = "delete"), b),
        eq: (c: string, v: unknown) => (filters.push((r) => r[c] === v), b),
        in: (c: string, v: unknown[]) => (filters.push((r) => v.includes(r[c])), b),
        not: (c: string) => (filters.push((r) => r[c] !== null && r[c] !== undefined), b),
        lte: () => b,
        or: () => b,
        order: () => b,
        limit: (n: number) => ((max = n), b),
        maybeSingle: async () => ({ data: matched()[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(run()).then(resolve),
      };
      return b;
    },
  };
  return db;
}

const connection = vi.hoisted(() => ({
  value: { connected: true, revoked: false, workspaceId: "ws-1", managerUserId: "mgr-1", pageId: "page-1", pageName: "P", igAccountId: "ig-1", igUsername: "ig", pageToken: "tok" } as Record<string, unknown> | null,
}));
const contact = vi.hoisted(() => ({ phone: "(206) 555-0100" as string | null }));
const graph = vi.hoisted(() => ({
  publishMetaPagePhoto: vi.fn(async () => "fb-post-1"),
  publishInstagramPhoto: vi.fn(async () => "ig-media-1"),
  deleteMetaPost: vi.fn(async () => undefined),
}));

vi.mock("next/server", () => ({ after: (task: () => Promise<void>) => void task() }));
vi.mock("@/lib/listing-channels/meta/connection.server", () => ({
  loadMetaConnection: async () => connection.value,
  markMetaConnectionRevoked: vi.fn(async () => undefined),
}));
vi.mock("@/lib/listing-channels/meta/graph.server", () => ({
  ...graph,
  MetaGraphError: class MetaGraphError extends Error {
    needsReconnect = false;
    code = 1;
  },
}));
vi.mock("@/lib/public-listings.server", () => ({
  asProperty: (value: unknown, id: string) => ({ ...(value as object), id }),
  publicListingProjection: (p: unknown) => p,
}));
vi.mock("@/lib/sms/manager-number-provisioning.server", () => ({ resolveActiveManagerSendNumber: async () => contact.phone }));
vi.mock("@/lib/manager-assistant-email/manager-assistant-email.server", () => ({ resolveActiveManagerWorkEmail: async () => "work@proplane.test" }));

import { processListingChannelQueue, syncListingChannelsForProperty } from "@/lib/listing-channels/sync.server";

function listingRecord(over: { status?: string; photo?: boolean; rent?: number } = {}): Row {
  const property = {
    title: "Ballard House",
    buildingName: "Ballard House",
    address: "123 Main St",
    beds: 3,
    baths: 2,
    listingSubmission: {
      v: 1,
      houseOverview: "Nice home.",
      housePhotoDataUrls: over.photo === false ? [] : ["https://cdn.proplane.test/p.jpg"],
      entireHomeMonthlyRent: over.rent ?? 2200,
      listingPlaceCategoryId: "entire_home",
      rooms: [],
      quickFacts: [],
    },
  } as unknown as MockProperty;
  return { id: "prop-1", manager_user_id: "mgr-1", workspace_id: "ws-1", status: over.status ?? "live", property_data: property };
}

const posts = (db: ReturnType<typeof fakeDb>) => db.tables.listing_channel_posts;

beforeEach(() => {
  process.env.META_APP_ID = "app";
  process.env.META_APP_SECRET = "secret";
  process.env.META_APP_LIVE = "1";
  contact.phone = "(206) 555-0100";
  connection.value = { connected: true, revoked: false, workspaceId: "ws-1", managerUserId: "mgr-1", pageId: "page-1", pageName: "P", igAccountId: "ig-1", igUsername: "ig", pageToken: "tok" };
  Object.values(graph).forEach((fn) => fn.mockClear());
});
afterEach(() => {
  delete process.env.META_APP_ID;
  delete process.env.META_APP_SECRET;
  delete process.env.META_APP_LIVE;
});

describe("listing channel sync", () => {
  it("does nothing while the Meta channels are Coming soon", async () => {
    delete process.env.META_APP_LIVE;
    const db = fakeDb({ properties: [listingRecord()] });
    await syncListingChannelsForProperty(db as never, "prop-1");
    expect(posts(db)).toHaveLength(0);
  });

  it("does nothing when the workspace has not connected Facebook", async () => {
    connection.value = null;
    const db = fakeDb({ properties: [listingRecord()] });
    await syncListingChannelsForProperty(db as never, "prop-1");
    expect(posts(db)).toHaveLength(0);
  });

  it("a new live listing queues a publish on every connected channel (default ON)", async () => {
    const db = fakeDb({ properties: [listingRecord()] });
    await syncListingChannelsForProperty(db as never, "prop-1");
    expect(posts(db).map((r) => [r.channel, r.state, r.pending_action, r.enabled])).toEqual([
      ["facebook_page", "pending", "publish", true],
      ["instagram", "pending", "publish", true],
    ]);
  });

  it("leaves a listing the manager posted by hand alone, so Meta going live never doubles the ad", async () => {
    const db = fakeDb({
      properties: [listingRecord()],
      posts: [
        {
          id: "row-hand",
          manager_user_id: "mgr-1",
          workspace_id: "ws-1",
          property_id: "prop-1",
          channel: "facebook_page",
          enabled: true,
          state: "posted_by_me",
          pending_action: null,
          posted_at: "2026-10-08T20:00:00Z",
        },
      ],
    });
    await syncListingChannelsForProperty(db as never, "prop-1");
    expect(posts(db).find((r) => r.channel === "facebook_page")).toMatchObject({ state: "posted_by_me", pending_action: null });
    await processListingChannelQueue(db as never);
    expect(graph.publishMetaPagePhoto).not.toHaveBeenCalled();
  });

  it("holds a listing with no photo, with the reason, and posts nothing", async () => {
    const db = fakeDb({ properties: [listingRecord({ photo: false })] });
    await syncListingChannelsForProperty(db as never, "prop-1");
    expect(posts(db).every((r) => r.state === "held" && r.pending_action === null && r.last_error === "no_photo")).toBe(true);
    await processListingChannelQueue(db as never);
    expect(graph.publishMetaPagePhoto).not.toHaveBeenCalled();
    expect(graph.publishInstagramPhoto).not.toHaveBeenCalled();
  });

  it("holds when the workspace has no work number: Set up work number, nothing posts", async () => {
    contact.phone = null;
    const db = fakeDb({ properties: [listingRecord()] });
    await syncListingChannelsForProperty(db as never, "prop-1");
    expect(posts(db).every((r) => r.state === "held" && r.last_error === "no_work_number")).toBe(true);
  });

  it("a draft listing posts nothing", async () => {
    const db = fakeDb({ properties: [listingRecord({ status: "draft" })] });
    await syncListingChannelsForProperty(db as never, "prop-1");
    expect(posts(db)).toHaveLength(0);
  });

  it("publishes through the queue, then a changed price queues an update (repost) and the same listing queues nothing", async () => {
    const db = fakeDb({ properties: [listingRecord()] });
    await syncListingChannelsForProperty(db as never, "prop-1");
    await processListingChannelQueue(db as never);
    const fb = posts(db).find((r) => r.channel === "facebook_page")!;
    expect(fb).toMatchObject({ state: "posted", external_id: "fb-post-1", pending_action: null });
    expect(graph.publishMetaPagePhoto).toHaveBeenCalledTimes(1);
    const call = graph.publishMetaPagePhoto.mock.calls[0]![0] as { caption: string; photoUrl: string };
    expect(call.caption).toContain("(206) 555-0100");
    expect(call.caption).toContain("work@proplane.test");
    expect(call.photoUrl).toBe("https://cdn.proplane.test/p.jpg");

    await syncListingChannelsForProperty(db as never, "prop-1");
    expect(posts(db).every((r) => r.pending_action === null)).toBe(true);

    db.tables.manager_property_records[0] = listingRecord({ rent: 2400 });
    await syncListingChannelsForProperty(db as never, "prop-1");
    expect(posts(db).find((r) => r.channel === "facebook_page")?.pending_action).toBe("update");
    await processListingChannelQueue(db as never);
    expect(graph.deleteMetaPost).toHaveBeenCalledWith({ postId: "fb-post-1", token: "tok" });
    expect(graph.publishMetaPagePhoto).toHaveBeenCalledTimes(2);
  });

  it("unlisting removes the Facebook post; Instagram's API cannot, and the row says so", async () => {
    const db = fakeDb({ properties: [listingRecord()] });
    await syncListingChannelsForProperty(db as never, "prop-1");
    await processListingChannelQueue(db as never);
    db.tables.manager_property_records[0] = listingRecord({ status: "unlisted" });
    await syncListingChannelsForProperty(db as never, "prop-1");
    expect(posts(db).every((r) => r.pending_action === "unpublish")).toBe(true);
    await processListingChannelQueue(db as never);
    expect(graph.deleteMetaPost).toHaveBeenCalledWith({ postId: "fb-post-1", token: "tok" });
    const ig = posts(db).find((r) => r.channel === "instagram")!;
    expect(ig.state).toBe("off");
    expect(String(ig.last_error)).toContain("Instagram");
  });

  it("a manager's per-listing OFF stops posting and takes a posted listing down", async () => {
    const db = fakeDb({ properties: [listingRecord()] });
    await syncListingChannelsForProperty(db as never, "prop-1");
    await processListingChannelQueue(db as never);
    posts(db).find((r) => r.channel === "facebook_page")!.enabled = false;
    await syncListingChannelsForProperty(db as never, "prop-1");
    expect(posts(db).find((r) => r.channel === "facebook_page")?.pending_action).toBe("unpublish");
    expect(posts(db).find((r) => r.channel === "instagram")?.pending_action).toBeNull();
  });

  it("a failed call backs off and retries, then gives up after the attempt cap", async () => {
    graph.publishMetaPagePhoto.mockRejectedValue(new Error("Graph exploded"));
    const db = fakeDb({ properties: [listingRecord()] });
    await syncListingChannelsForProperty(db as never, "prop-1");
    await processListingChannelQueue(db as never);
    const fb = posts(db).find((r) => r.channel === "facebook_page")!;
    expect(fb.state).toBe("pending");
    expect(fb.pending_action).toBe("publish");
    expect(fb.last_error).toBe("Graph exploded");
    expect(typeof fb.next_attempt_at).toBe("string");
    fb.attempts = 5;
    await processListingChannelQueue(db as never);
    expect(fb.state).toBe("failed");
    expect(fb.pending_action).toBeNull();
    graph.publishMetaPagePhoto.mockResolvedValue("fb-post-1");
  });

  it("deleting a property takes its posted listings down and drops unposted rows", async () => {
    const db = fakeDb({
      posts: [
        { id: "a", property_id: "gone", channel: "facebook_page", state: "posted", external_id: "x1", pending_action: null },
        { id: "b", property_id: "gone", channel: "instagram", state: "held", external_id: null, pending_action: null },
      ],
    });
    await syncListingChannelsForProperty(db as never, "gone", { deleted: true });
    expect(posts(db)).toHaveLength(1);
    expect(posts(db)[0]).toMatchObject({ id: "a", pending_action: "unpublish" });
  });
});
