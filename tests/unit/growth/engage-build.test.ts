import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));
vi.mock("@/lib/agent/model", () => ({ TIER_MODELS: { standard: "test-model" } }));

import { buildEngageList } from "@/lib/growth/engage/build.server";

const thread = (id: string) => ({
  data: { id, title: `Thread ${id}`, permalink: `/r/Landlord/comments/${id}/t/`, subreddit: "Landlord", ups: 9, num_comments: 3, created_utc: Date.now() / 1000 - 3600, selftext: "", over_18: false },
});

function fakeDb(existing: { url: string; for_date: string }[]) {
  const upserted: Record<string, unknown>[] = [];
  const db = {
    from(table: string) {
      const q: Record<string, unknown> = {};
      const chain = () => q;
      q.select = (cols?: string) => {
        if (table === "growth_engage_items" && cols === "url,for_date") return { gte: async () => ({ data: existing, error: null }) };
        return q;
      };
      q.eq = chain;
      q.in = chain;
      q.order = async () => ({ data: [], error: null });
      q.upsert = (rows: Record<string, unknown>[]) => {
        upserted.push(...rows);
        return { select: async () => ({ data: rows.map((_, i) => ({ id: String(i) })), error: null }) };
      };
      return q;
    },
  };
  return { db: db as never, upserted };
}

const fetchWith = (ids: string[]) =>
  (async () => new Response(JSON.stringify({ data: { children: ids.map(thread) } }), { status: 200 })) as unknown as typeof fetch;

const reply = (items: unknown[]) => ({ content: [{ type: "text", text: JSON.stringify({ items }) }] });

beforeEach(() => {
  create.mockReset();
  process.env.ANTHROPIC_API_KEY = "test";
});

describe("buildEngageList", () => {
  it("skips urls already listed and inserts drafted items", async () => {
    create.mockResolvedValue(reply([{ key: "reddit:b", why: "w".repeat(200), draft: "Try a late fee clause." }]));
    const { db, upserted } = fakeDb([{ url: "https://www.reddit.com/r/Landlord/comments/a/t/", for_date: "2026-10-01" }]);
    const res = await buildEngageList({ forDate: "2026-10-09", fetchImpl: fetchWith(["a", "b"]) }, db);
    expect(res.inserted).toBe(1);
    expect(upserted).toHaveLength(1);
    expect(upserted[0]).toMatchObject({ for_date: "2026-10-09", source: "reddit", url: "https://www.reddit.com/r/Landlord/comments/b/t/", status: "open" });
    expect((upserted[0].why as string).length).toBe(90);
    expect(upserted[0].evidence).toMatchObject({ threadId: "b", ups: 9, numComments: 3 });
  });

  it("a drafting failure skips the items and never throws", async () => {
    create.mockRejectedValue(new Error("boom"));
    const { db, upserted } = fakeDb([]);
    const res = await buildEngageList({ forDate: "2026-10-09", fetchImpl: fetchWith(["a"]) }, db);
    expect(res).toMatchObject({ inserted: 0, skipped: 1 });
    expect(upserted).toHaveLength(0);
  });

  it("omits items Claude did not return", async () => {
    create.mockResolvedValue(reply([{ key: "reddit:a", why: "ok", draft: "d" }]));
    const { db, upserted } = fakeDb([]);
    const res = await buildEngageList({ forDate: "2026-10-09", fetchImpl: fetchWith(["a", "b"]) }, db);
    expect(res.inserted).toBe(1);
    expect(upserted).toHaveLength(1);
  });
});
