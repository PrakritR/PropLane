import { beforeEach, describe, expect, it, vi } from "vitest";

type Call = { op: "upsert" | "delete" | "select"; values?: Record<string, unknown>; onConflict?: string; eq?: [string, unknown][] };

const h = vi.hoisted(() => ({
  ctx: null as null | { db: unknown; userId: string; workspace: { id: string; ownerUserId: string; owned: boolean } },
  calls: [] as Call[],
  rows: [] as Record<string, unknown>[],
}));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/listing-channels/route-context.server", () => ({
  resolveListingChannelContext: async () => h.ctx,
}));

import { DELETE, GET, POST } from "@/app/api/manager/vendor-marketplace-accounts/route";

const db = {
  from: () => ({
    upsert: async (values: Record<string, unknown>, opts?: { onConflict?: string }) => {
      h.calls.push({ op: "upsert", values, onConflict: opts?.onConflict });
      return { error: null };
    },
    delete: () => {
      const call: Call = { op: "delete", eq: [] };
      h.calls.push(call);
      const chain = {
        eq: (col: string, val: unknown) => {
          call.eq!.push([col, val]);
          return call.eq!.length >= 2 ? Promise.resolve({ error: null }) : chain;
        },
      };
      return chain;
    },
    select: () => {
      const call: Call = { op: "select", eq: [] };
      h.calls.push(call);
      const chain = {
        eq: (col: string, val: unknown) => {
          call.eq!.push([col, val]);
          return chain;
        },
        order: async () => ({ data: h.rows, error: null }),
      };
      return chain;
    },
  }),
};

const req = (method: string, body?: Record<string, unknown>) =>
  new Request("https://proplane.ai/api/manager/vendor-marketplace-accounts", { method, ...(body ? { body: JSON.stringify(body) } : {}) });

describe("vendor-marketplace-accounts route", () => {
  beforeEach(() => {
    h.ctx = { db, userId: "u", workspace: { id: "w-1", ownerUserId: "owner-1", owned: true } };
    h.calls = [];
    h.rows = [];
  });

  it("is 401 for every method when nobody is signed in", async () => {
    h.ctx = null;
    expect((await GET(req("GET"))).status).toBe(401);
    expect((await POST(req("POST", { marketplace: "yelp", accountLabel: "a@b.co" }))).status).toBe(401);
    expect((await DELETE(req("DELETE", { marketplace: "yelp" }))).status).toBe(401);
    expect(h.calls).toHaveLength(0);
  });

  it("rejects a marketplace that is not in the registry", async () => {
    const res = await POST(req("POST", { marketplace: "porch", accountLabel: "a@b.co" }));
    expect(res.status).toBe(400);
    expect((await DELETE(req("DELETE", { marketplace: "../x" }))).status).toBe(400);
    expect(h.calls).toHaveLength(0);
  });

  it("rejects an http or malformed profile link", async () => {
    for (const profileUrl of ["http://www.yelp.com/biz/me", "javascript:alert(1)", "not a url"]) {
      expect((await POST(req("POST", { marketplace: "yelp", accountLabel: "a@b.co", profileUrl }))).status).toBe(400);
    }
    expect(h.calls).toHaveLength(0);
  });

  it("rejects an empty or over-long label", async () => {
    expect((await POST(req("POST", { marketplace: "yelp", accountLabel: "   " }))).status).toBe(400);
    expect((await POST(req("POST", { marketplace: "yelp", accountLabel: "x".repeat(121) }))).status).toBe(400);
    expect((await POST(req("POST", { marketplace: "yelp", accountLabel: "x".repeat(120) }))).status).toBe(200);
  });

  it("refuses a workspace member who is not the owner", async () => {
    h.ctx = { db, userId: "u2", workspace: { id: "w-1", ownerUserId: "owner-1", owned: false } };
    expect((await POST(req("POST", { marketplace: "yelp", accountLabel: "a@b.co" }))).status).toBe(403);
    expect((await DELETE(req("DELETE", { marketplace: "yelp" }))).status).toBe(403);
    expect(h.calls).toHaveLength(0);
  });

  it("upserts on the active workspace and marketplace, owned by the workspace owner, ignoring ids in the body", async () => {
    const res = await POST(
      req("POST", { marketplace: "thumbtack", accountLabel: " me@pm.co ", profileUrl: "https://www.thumbtack.com/pm", manager_user_id: "evil", workspace_id: "w-evil" }),
    );
    expect(res.status).toBe(200);
    expect(h.calls[0]).toMatchObject({ op: "upsert", onConflict: "workspace_id,marketplace" });
    expect(h.calls[0]!.values).toMatchObject({
      workspace_id: "w-1",
      manager_user_id: "owner-1",
      marketplace: "thumbtack",
      account_label: "me@pm.co",
      profile_url: "https://www.thumbtack.com/pm",
    });
  });

  it("stores no link when none is given", async () => {
    await POST(req("POST", { marketplace: "bark", accountLabel: "me", profileUrl: "" }));
    expect(h.calls[0]!.values).toMatchObject({ marketplace: "bark", profile_url: null });
  });

  it("deletes only the active workspace's row for that marketplace", async () => {
    expect((await DELETE(req("DELETE", { marketplace: "yelp" }))).status).toBe(200);
    expect(h.calls[0]).toMatchObject({ op: "delete", eq: [["workspace_id", "w-1"], ["marketplace", "yelp"]] });
  });

  it("lists the active workspace's accounts and carries no credential", async () => {
    h.rows = [{ marketplace: "yelp", account_label: "me@pm.co", profile_url: null, connected_at: "2026-10-08T10:00:00Z" }];
    const res = await GET(req("GET"));
    const json = await res.json();
    expect(h.calls[0]).toMatchObject({ op: "select", eq: [["workspace_id", "w-1"]] });
    expect(json.accounts).toEqual([{ marketplace: "yelp", accountLabel: "me@pm.co", profileUrl: null, connectedAt: "2026-10-08T10:00:00Z" }]);
  });
});
