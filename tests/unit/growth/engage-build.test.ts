import { beforeEach, describe, expect, it, vi } from "vitest";

const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({ default: class { messages = { create }; } }));
vi.mock("@/lib/agent/model", () => ({ TIER_MODELS: { standard: "test-model" } }));

import { buildEngageList } from "@/lib/growth/engage/build.server";

const thread = (id: string) => ({
  data: { id, title: `Thread ${id}`, permalink: `/r/Landlord/comments/${id}/t/`, subreddit: "Landlord", ups: 9, num_comments: 3, created_utc: Date.now() / 1000 - 3600, selftext: "", over_18: false },
});

type Row = Record<string, unknown>;

/**
 * In-memory stand-in for the two tables the build reads. The engage table honours
 * eq / gte / limit / range so the paged window read and the per-url existence check
 * can be exercised separately — `windowBlind` answers the paged read with nothing,
 * which is exactly how PostgREST's row cap drops rows.
 */
function fakeDb(existing: { url: string; for_date: string }[], opts: { windowBlind?: boolean } = {}) {
  const upserted: Row[] = [];
  const rows: Row[] = existing.map((r, i) => ({ id: `e${i}`, ...r }));

  function query(source: Row[]) {
    const state = { rows: [...source], limit: null as number | null };
    const api: Record<string, unknown> = {};
    const page = () => (state.limit == null ? state.rows : state.rows.slice(0, state.limit));
    Object.assign(api, {
      select: () => api,
      eq: (c: string, v: unknown) => {
        state.rows = state.rows.filter((r) => r[c] === v);
        return api;
      },
      gte: (c: string, v: string) => {
        state.rows = state.rows.filter((r) => String(r[c]) >= v);
        return api;
      },
      in: () => api,
      order: () => api,
      limit: (n: number) => {
        state.limit = n;
        return api;
      },
      range: (from: number, to: number) =>
        Promise.resolve({ data: opts.windowBlind ? [] : state.rows.slice(from, to + 1), error: null }),
      then: (res: (v: unknown) => unknown) => Promise.resolve({ data: page(), error: null }).then(res),
    });
    return api;
  }

  const db = {
    from(table: string) {
      if (table !== "growth_engage_items") return query([]);
      const q = query(rows) as Record<string, unknown>;
      q.upsert = (insert: Row[]) => {
        upserted.push(...insert);
        return { select: async () => ({ data: insert.map((_, i) => ({ id: String(i) })), error: null }) };
      };
      return q;
    },
  };
  return { db: db as never, upserted };
}

const fetchWith = (ids: string[]) =>
  (async () => new Response(JSON.stringify({ data: { children: ids.map(thread) } }), { status: 200 })) as unknown as typeof fetch;

const reply = (items: unknown[], stop: string = "end_turn") => ({
  stop_reason: stop,
  content: [{ type: "text", text: JSON.stringify({ items }) }],
});

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

  it("still skips a listed url when the paged window read misses it", async () => {
    create.mockResolvedValue(reply([{ key: "reddit:a", why: "ok", draft: "d" }]));
    const { db, upserted } = fakeDb([{ url: "https://www.reddit.com/r/Landlord/comments/a/t/", for_date: "2026-10-01" }], { windowBlind: true });
    const res = await buildEngageList({ forDate: "2026-10-09", fetchImpl: fetchWith(["a"]) }, db);
    expect(res).toMatchObject({ considered: 0, inserted: 0 });
    expect(upserted).toHaveLength(0);
  });

  it("ignores a url listed before the dedupe window", async () => {
    create.mockResolvedValue(reply([{ key: "reddit:a", why: "ok", draft: "d" }]));
    const { db, upserted } = fakeDb([{ url: "https://www.reddit.com/r/Landlord/comments/a/t/", for_date: "2026-01-01" }]);
    const res = await buildEngageList({ forDate: "2026-10-09", fetchImpl: fetchWith(["a"]) }, db);
    expect(res.inserted).toBe(1);
    expect(upserted).toHaveLength(1);
  });

  it("a drafting failure skips the items and never throws", async () => {
    create.mockRejectedValue(new Error("boom"));
    const { db, upserted } = fakeDb([]);
    const res = await buildEngageList({ forDate: "2026-10-09", fetchImpl: fetchWith(["a"]) }, db);
    expect(res).toMatchObject({ inserted: 0, skipped: 1 });
    expect(upserted).toHaveLength(0);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("retries once when the reply is truncated, then keeps the batch", async () => {
    create.mockResolvedValueOnce(reply([{ key: "reddit:a", why: "ok", draft: "cut off" }], "max_tokens"));
    create.mockResolvedValue(reply([{ key: "reddit:a", why: "ok", draft: "Short answer." }]));
    const { db, upserted } = fakeDb([]);
    const res = await buildEngageList({ forDate: "2026-10-09", fetchImpl: fetchWith(["a"]) }, db);
    expect(create).toHaveBeenCalledTimes(2);
    expect(res.inserted).toBe(1);
    expect(upserted[0]).toMatchObject({ draft: "Short answer." });
  });

  it("asks for enough tokens for a batch of five", async () => {
    create.mockResolvedValue(reply([{ key: "reddit:a", why: "ok", draft: "d" }]));
    const { db } = fakeDb([]);
    await buildEngageList({ forDate: "2026-10-09", fetchImpl: fetchWith(["a"]) }, db);
    expect(create.mock.calls[0][0]).toMatchObject({ max_tokens: 8000 });
  });

  it("omits items Claude did not return", async () => {
    create.mockResolvedValue(reply([{ key: "reddit:a", why: "ok", draft: "d" }]));
    const { db, upserted } = fakeDb([]);
    const res = await buildEngageList({ forDate: "2026-10-09", fetchImpl: fetchWith(["a", "b"]) }, db);
    expect(res.inserted).toBe(1);
    expect(upserted).toHaveLength(1);
  });
});
