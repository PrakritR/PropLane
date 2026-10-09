import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchRedditThreads, parseRedditListing, resetRedditTokenCache } from "@/lib/growth/engage/reddit.server";

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
    expect((fetchImpl.mock.calls[0][1] as RequestInit).headers).toMatchObject({ "User-Agent": "PropLane growth/1.0 (by /u/proplane)" });
    expect(out).toHaveLength(1);
  });
});

describe("fetchRedditThreads app-only OAuth", () => {
  const listing = () => new Response(JSON.stringify({ data: { children: [child({})] } }), { status: 200 });
  const tokenRes = (t = "tok", expires = 3600) => new Response(JSON.stringify({ access_token: t, expires_in: expires }), { status: 200 });
  const hdr = (c: unknown[]) => ((c[1] as RequestInit).headers ?? {}) as Record<string, string>;

  beforeEach(() => {
    resetRedditTokenCache();
    vi.stubEnv("REDDIT_CLIENT_ID", "cid");
    vi.stubEnv("REDDIT_CLIENT_SECRET", "sec");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("requests a token then calls the oauth host with a bearer", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => (String(url).includes("/api/v1/access_token") ? tokenRes() : listing()));
    await fetchRedditThreads(fetchImpl as unknown as typeof fetch, NOW, ["Landlord"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [tUrl, tInit] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(tUrl).toBe("https://www.reddit.com/api/v1/access_token");
    expect(tInit.method).toBe("POST");
    expect(tInit.body).toBe("grant_type=client_credentials");
    expect(hdr(fetchImpl.mock.calls[0]).Authorization).toBe(`Basic ${Buffer.from("cid:sec").toString("base64")}`);
    expect(String(fetchImpl.mock.calls[1][0])).toMatch(/^https:\/\/oauth\.reddit\.com\/r\/Landlord\/search\.json\?/);
    expect(hdr(fetchImpl.mock.calls[1])).toMatchObject({ Authorization: "Bearer tok", "User-Agent": "PropLane growth/1.0 (by /u/proplane)" });
  });

  it("caches the token across calls", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => (String(url).includes("/api/v1/access_token") ? tokenRes() : listing()));
    await fetchRedditThreads(fetchImpl as unknown as typeof fetch, NOW, ["Landlord"]);
    await fetchRedditThreads(fetchImpl as unknown as typeof fetch, NOW + 1000, ["Landlord"]);
    const tokenCalls = fetchImpl.mock.calls.filter((c) => String(c[0]).includes("/api/v1/access_token"));
    expect(tokenCalls).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("refreshes once on 401 and retries", async () => {
    let tokens = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes("/api/v1/access_token")) return tokenRes(`tok${++tokens}`);
      if ((init?.headers as Record<string, string>).Authorization === "Bearer tok1") return new Response("no", { status: 401 });
      return listing();
    });
    const out = await fetchRedditThreads(fetchImpl as unknown as typeof fetch, NOW, ["Landlord"]);
    expect(tokens).toBe(2);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect(out).toHaveLength(1);
  });

  it("stays anonymous on the www host with no Authorization when creds are unset", async () => {
    vi.unstubAllEnvs();
    vi.stubEnv("REDDIT_CLIENT_ID", "");
    vi.stubEnv("REDDIT_CLIENT_SECRET", "");
    const fetchImpl = vi.fn(async () => listing());
    await fetchRedditThreads(fetchImpl as unknown as typeof fetch, NOW, ["Landlord"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String((fetchImpl.mock.calls[0] as unknown[])[0])).toMatch(/^https:\/\/www\.reddit\.com\/r\/Landlord\/search\.json\?/);
    expect(hdr(fetchImpl.mock.calls[0] as unknown[])).not.toHaveProperty("Authorization");
  });
});
