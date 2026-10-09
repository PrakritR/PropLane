import { describe, expect, it, vi } from "vitest";
import { fetchRedditThreads, parseRedditListing } from "@/lib/growth/engage/reddit.server";

const NOW = Date.UTC(2026, 9, 8, 12, 0, 0);
const sec = (daysAgo: number) => (NOW - daysAgo * 86_400_000) / 1000;
const child = (o: Record<string, unknown>) => ({
  data: { id: "a", title: "T", permalink: "/r/Landlord/comments/a/t/", subreddit: "Landlord", ups: 10, num_comments: 4, created_utc: sec(1), selftext: "x".repeat(900), over_18: false, ...o },
});

describe("parseRedditListing", () => {
  it("keeps fresh SFW threads with enough upvotes and truncates selftext", () => {
    const out = parseRedditListing({ data: { children: [child({})] } }, NOW);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: "a", url: "https://www.reddit.com/r/Landlord/comments/a/t/", ups: 10, numComments: 4 });
    expect(out[0].selftext).toHaveLength(600);
  });
  it("drops old, NSFW and low-upvote threads", () => {
    const out = parseRedditListing(
      { data: { children: [child({ id: "old", created_utc: sec(8) }), child({ id: "nsfw", over_18: true }), child({ id: "low", ups: 2 }), child({ id: "ok" })] } },
      NOW,
    );
    expect(out.map((t) => t.id)).toEqual(["ok"]);
  });
  it("tolerates garbage", () => {
    expect(parseRedditListing(null, NOW)).toEqual([]);
    expect(parseRedditListing({ data: {} }, NOW)).toEqual([]);
  });
});

describe("fetchRedditThreads", () => {
  it("makes one request per subreddit, sets the user agent, dedupes and survives a failing subreddit", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("/r/realestateinvesting/")) return new Response("no", { status: 429 });
      return new Response(JSON.stringify({ data: { children: [child({})] } }), { status: 200 });
    });
    const out = await fetchRedditThreads(fetchImpl as unknown as typeof fetch, NOW);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect((fetchImpl.mock.calls[0][1] as RequestInit).headers).toMatchObject({ "User-Agent": "PropLane growth/1.0" });
    expect(out).toHaveLength(1);
  });
});
