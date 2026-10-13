import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const deliver = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ action: "appended" })));
const contact = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ phone: "+18146793694" as string | null, email: "homes@work.proplane.ai" as string | null })));
vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => void fn(), NextResponse: { json: (b: unknown) => Response.json(b) } }));
vi.mock("@/lib/portal-inbox-delivery", () => ({ deliverPortalMessageThreadSide: deliver, scopeForRole: () => "manager" }));
vi.mock("@/lib/listing-channels/sync.server", () => ({
  resolveListingPostContact: contact,
  loadSyncListing: async (_db: unknown, id: string) => ({
    propertyId: id, managerUserId: "m1", workspaceId: "w1", live: true, projected: { title: "Room 3 at 5257 Brooklyn Ave", buildingName: "" },
  }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => ({}) }));

import { GET, POST } from "@/app/api/webhooks/meta/messenger/route";
import { extractMessengerInbound, handleMessengerInbound, verifyMetaWebhookSignature } from "@/lib/listing-channels/meta/messenger.server";
import { withRepliesFact } from "@/lib/listing-channels/row-fact";

const SECRET = "app-secret";
const conn = { pageId: "P1", workspaceId: "w1", managerUserId: "m1", pageToken: "tok" } as never;

function fakeDb() {
  const replies = new Map<string, { replied_at: string }>();
  const db = {
    // Mirrors claim_meta_messenger_reply: insert, or update only when the prior reply is older than 24h.
    rpc: async (_fn: string, a: { p_page_id: string; p_sender_psid: string; p_now: string }) => {
      const key = `${a.p_page_id}:${a.p_sender_psid}`;
      const prior = replies.get(key);
      if (prior && new Date(a.p_now).getTime() - new Date(prior.replied_at).getTime() < 24 * 3600 * 1000) return { data: [], error: null };
      replies.set(key, { replied_at: a.p_now });
      return { data: [{ page_id: a.p_page_id }], error: null };
    },
    from(table: string) {
      const f: Record<string, string> = {};
      const q: Record<string, unknown> = {
        select: () => q, eq: (k: string, v: string) => ((f[k] = v), q), order: () => q, limit: () => q,
        maybeSingle: async () => {
          if (table === "meta_messenger_replies") return { data: replies.get(`${f.page_id}:${f.sender_psid}`) ?? null };
          return { data: { id: "prop1" } };
        },
        upsert: async (row: { page_id: string; sender_psid: string; replied_at: string }) => {
          replies.set(`${row.page_id}:${row.sender_psid}`, { replied_at: row.replied_at });
          return { error: null };
        },
        delete: () => ({ eq: () => ({ eq: async () => ({}) }) }),
      };
      return q;
    },
  };
  return { db: db as never, replies };
}

const inbound = { pageId: "P1", senderPsid: "S1", text: "Is it available?", mid: "m.1", ref: null };

beforeEach(() => {
  deliver.mockClear();
  contact.mockResolvedValue({ phone: "+18146793694", email: "homes@work.proplane.ai" });
  process.env.META_WEBHOOK_VERIFY_TOKEN = "vt";
  process.env.META_APP_SECRET = SECRET;
});

describe("webhook handshake and signature", () => {
  it("GET echoes the challenge only for the right verify token", async () => {
    const ok = await GET(new Request("https://x/api/webhooks/meta/messenger?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=abc"));
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe("abc");
    const bad = await GET(new Request("https://x/api/webhooks/meta/messenger?hub.mode=subscribe&hub.verify_token=no&hub.challenge=abc"));
    expect(bad.status).toBe(403);
  });

  it("POST fails closed: bad signature, missing signature, unset secret", async () => {
    const body = JSON.stringify({ object: "page", entry: [] });
    const good = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
    expect(verifyMetaWebhookSignature(body, good, SECRET)).toBe(true);
    expect(verifyMetaWebhookSignature(body, good, "")).toBe(false);
    expect(verifyMetaWebhookSignature(body, "sha256=00", SECRET)).toBe(false);
    expect(verifyMetaWebhookSignature(body, null, SECRET)).toBe(false);
    const req = (sig: string) => new Request("https://x", { method: "POST", body, headers: { "x-hub-signature-256": sig } });
    expect((await POST(req("sha256=bad"))).status).toBe(403);
    expect((await POST(req(good))).status).toBe(200);
    delete process.env.META_APP_SECRET;
    expect((await POST(req(good))).status).toBe(403);
  });

  it("extracts only inbound text, never echoes, receipts or the Page's own sends", () => {
    const payload = {
      object: "page",
      entry: [{ id: "P1", messaging: [
        { sender: { id: "S1" }, recipient: { id: "P1" }, message: { mid: "a", text: "hi" } },
        { sender: { id: "P1" }, recipient: { id: "S1" }, message: { mid: "b", text: "echo", is_echo: true } },
        { sender: { id: "P1" }, recipient: { id: "P1" }, message: { mid: "c", text: "own" } },
        { sender: { id: "S1" }, recipient: { id: "P1" }, read: { watermark: 1 } },
        { sender: { id: "S1" }, recipient: { id: "P1" }, delivery: { mids: ["a"] } },
      ] }],
    };
    expect(extractMessengerInbound(payload)).toEqual([{ pageId: "P1", senderPsid: "S1", text: "hi", mid: "a", ref: null }]);
  });
});

describe("handleMessengerInbound", () => {
  it("replies once per sender per 24h and files the lead + reply", async () => {
    const { db } = fakeDb();
    const send = vi.fn(async () => "mid");
    const deps = { live: () => true, loadConnection: async () => conn, send, now: new Date("2026-10-13T10:00:00Z") };
    expect(await handleMessengerInbound(db, inbound, deps)).toBe("replied");
    expect(send).toHaveBeenCalledTimes(1);
    const sent = (send.mock.calls[0] as unknown as [{ text: string }])[0].text;
    expect(sent).toContain("(814) 679-3694");
    expect(sent).toContain("homes@work.proplane.ai");
    expect(sent).toContain("This inbox isn't watched.");
    expect(deliver).toHaveBeenCalledTimes(2);
    expect((deliver.mock.calls[1][1] as { channel: string; outbound: boolean }).outbound).toBe(true);
    // Same sender an hour later: lead filed, no second reply.
    const later = { ...deps, now: new Date("2026-10-13T11:00:00Z") };
    expect(await handleMessengerInbound(db, { ...inbound, mid: "m.2" }, later)).toBe("already_replied");
    expect(send).toHaveBeenCalledTimes(1);
    // 25 hours later: replies again.
    expect(await handleMessengerInbound(db, { ...inbound, mid: "m.3" }, { ...deps, now: new Date("2026-10-14T11:00:00Z") })).toBe("replied");
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("concurrent deliveries for one sender send exactly once (atomic claim)", async () => {
    const { db } = fakeDb();
    const send = vi.fn(async () => "mid");
    const deps = { live: () => true, loadConnection: async () => conn, send, now: new Date("2026-10-13T10:00:00Z") };
    const results = await Promise.all([
      handleMessengerInbound(db, { ...inbound, mid: "a" }, deps),
      handleMessengerInbound(db, { ...inbound, mid: "b" }, deps),
    ]);
    expect(results.sort()).toEqual(["already_replied", "replied"]);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("files the lead under a stable per-message id so a redelivery appends once", async () => {
    const { db } = fakeDb();
    const deps = { live: () => true, loadConnection: async () => conn, send: vi.fn(async () => "x") };
    await handleMessengerInbound(db, inbound, deps);
    await handleMessengerInbound(db, inbound, deps);
    const ids = deliver.mock.calls.map((c) => (c[1] as { messageId: string }).messageId).filter((id) => id === "facebook-in:m.1");
    expect(ids).toHaveLength(2); // same id both times: the store skips the duplicate
    expect(new Set(ids).size).toBe(1);
  });

  it("no work number sends nothing (lead still filed)", async () => {
    contact.mockResolvedValue({ phone: null, email: "e@x" });
    const { db } = fakeDb();
    const send = vi.fn();
    expect(await handleMessengerInbound(db, inbound, { live: () => true, loadConnection: async () => conn, send })).toBe("lead_only");
    expect(send).not.toHaveBeenCalled();
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("ignores everything when the app is not live or the Page is not connected", async () => {
    const { db } = fakeDb();
    const send = vi.fn();
    expect(await handleMessengerInbound(db, inbound, { live: () => false, loadConnection: async () => conn, send })).toBe("ignored");
    expect(await handleMessengerInbound(db, inbound, { live: () => true, loadConnection: async () => null, send })).toBe("ignored");
    expect(send).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe("registry fact", () => {
  it("Facebook Page row says Replies: Coming soon, then on; other rows untouched", () => {
    expect(withRepliesFact("facebook_page", "Not connected", false)).toBe("Not connected · Replies: Coming soon");
    expect(withRepliesFact("facebook_page", "Posts for you · 2 of 3 listings", true)).toBe("Posts for you · 2 of 3 listings · Replies: on");
    expect(withRepliesFact("instagram", "x", true)).toBe("x");
  });
});
