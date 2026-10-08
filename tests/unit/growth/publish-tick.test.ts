import { describe, expect, it } from "vitest";
import { runPublishTick, type PublishStore } from "@/lib/growth/publish.server";
import type { GrowthAccount, GrowthPlatform, GrowthPost, GrowthPostStatus, GrowthPublication, GrowthPublisher } from "@/lib/growth/types";

const T0 = new Date("2026-10-08T16:00:00Z");
const min = (n: number) => new Date(T0.getTime() + n * 60_000);

function post(platforms: GrowthPlatform[]): GrowthPost {
  return {
    id: "p1", ideaId: null, status: "scheduled", format: "text", title: "T", hook: "H", script: null, scenes: [],
    captions: { linkedin: "li caption", x: "x caption", instagram: "ig" }, platforms, scheduledFor: T0.toISOString(),
    approvedAt: null, approvedBy: null, publishedAt: null, createdBy: "claude", reviewNote: null, learnedFrom: null, createdAt: "", updatedAt: "",
  };
}
const acct = (platform: GrowthPlatform, status: GrowthAccount["status"] = "connected"): GrowthAccount => ({
  id: `a-${platform}`, platform, handle: "h", publisher: "log", vendorAccountId: "v", status, tokenExpiresAt: null, meta: {}, createdAt: "", updatedAt: "",
});

function memStore(p: GrowthPost, accounts: GrowthAccount[]) {
  const pubs = new Map<string, GrowthPublication>();
  const store: PublishStore = {
    async duePosts() { return p.status === "scheduled" || p.status === "publishing" ? [{ ...p }] : []; },
    async ensurePublication(_post, platform, publisher) {
      if (!pubs.has(platform)) pubs.set(platform, { id: `pub-${platform}`, postId: p.id, platform, accountId: null, status: "pending", publisher, vendorPostId: null, platformPostId: null, platformUrl: null, error: null, attempts: 0, lastAttemptAt: null, publishedAt: null });
      return { ...pubs.get(platform)! };
    },
    async updatePublication(id, patch) {
      for (const [k, v] of pubs) if (v.id === id) pubs.set(k, { ...v, ...patch });
    },
    async accountFor(platform) { return accounts.find((a) => a.platform === platform) ?? null; },
    async assets() { return []; },
    async setPost(_id, status: GrowthPostStatus) { p.status = status; },
  };
  return { store, pubs };
}

const okDriver = (calls: string[]): GrowthPublisher => ({
  id: "log",
  async publish(i) { calls.push(i.platform); return { ok: true, vendorPostId: `v-${i.platform}`, platformPostId: null, platformUrl: null }; },
});
const flaky = (calls: string[], failPlatform: GrowthPlatform): GrowthPublisher => ({
  id: "log",
  async publish(i) {
    calls.push(i.platform);
    if (i.platform === failPlatform) return { ok: false, error: "boom", retryable: true };
    return { ok: true, vendorPostId: "v", platformPostId: null, platformUrl: null };
  },
});

describe("runPublishTick", () => {
  it("publishes all platforms and is idempotent on re-run", async () => {
    const p = post(["linkedin", "x"]);
    const { store, pubs } = memStore(p, [acct("linkedin"), acct("x")]);
    const calls: string[] = [];
    const resolve = () => okDriver(calls);
    const r = await runPublishTick(T0, { store, resolve });
    expect(r.published).toBe(1);
    expect(p.status).toBe("published");
    expect([...pubs.values()].every((v) => v.status === "published")).toBe(true);
    await runPublishTick(min(10), { store, resolve });
    expect(calls).toEqual(["linkedin", "x"]);
  });

  it("partial failure keeps the others published, backs off, then fails after 3 attempts", async () => {
    const p = post(["linkedin", "x"]);
    const { store, pubs } = memStore(p, [acct("linkedin"), acct("x")]);
    const calls: string[] = [];
    const resolve = () => flaky(calls, "x");
    let r = await runPublishTick(T0, { store, resolve });
    expect(r.stillPublishing).toBe(1);
    expect(p.status).toBe("publishing");
    expect(pubs.get("linkedin")!.status).toBe("published");
    expect(pubs.get("x")).toMatchObject({ status: "pending", attempts: 1, error: "boom" });

    // inside the 5 min backoff: no retry
    await runPublishTick(min(4), { store, resolve });
    expect(calls.filter((c) => c === "x")).toHaveLength(1);
    // attempt 2 after 5*1 min, attempt 3 after 5*2 min
    await runPublishTick(min(5), { store, resolve });
    expect(pubs.get("x")!.attempts).toBe(2);
    await runPublishTick(min(14), { store, resolve });
    expect(pubs.get("x")!.attempts).toBe(2);
    r = await runPublishTick(min(15), { store, resolve });
    expect(r.failed).toBe(1);
    expect(p.status).toBe("failed");
    expect(pubs.get("linkedin")!.status).toBe("published");
    expect(calls.filter((c) => c === "linkedin")).toHaveLength(1);
  });

  it("pauses a platform with no connected account without failing the others", async () => {
    const p = post(["linkedin", "x"]);
    const { store, pubs } = memStore(p, [acct("linkedin")]);
    await runPublishTick(T0, { store, resolve: () => okDriver([]) });
    expect(pubs.get("x")!.status).toBe("paused");
    expect(p.status).toBe("published");
  });

  it("pauses a disconnected account", async () => {
    const p = post(["x"]);
    const { store, pubs } = memStore(p, [acct("x", "disconnected")]);
    const r = await runPublishTick(T0, { store, resolve: () => okDriver([]) });
    expect(pubs.get("x")!.status).toBe("paused");
    expect(r.published).toBe(0);
    expect(p.status).toBe("publishing");
  });
});

describe("production safety: never fake-publish", () => {
  const saved = { ...process.env };
  const restore = () => { process.env = { ...saved }; };

  it("log driver is allowed outside production, and in production only when explicit", async () => {
    const { resolvePublisher } = await import("@/lib/growth/publishers/index.server");
    try {
      delete process.env.GROWTH_PUBLISHER; delete process.env.VERCEL_ENV;
      (process.env as Record<string, string>).NODE_ENV = "test";
      expect(resolvePublisher(null)?.id).toBe("log");
      process.env.VERCEL_ENV = "preview";
      expect(resolvePublisher(null)?.id).toBe("log");
      process.env.VERCEL_ENV = "production";
      expect(resolvePublisher(null)).toBeNull();
      process.env.GROWTH_PUBLISHER = "log"; // explicit, still refused on Vercel production
      expect(resolvePublisher(null)).toBeNull();
      process.env.GROWTH_PUBLISHER = "late";
      expect(resolvePublisher(null)?.id).toBe("late");
    } finally { restore(); }
  });

  it("tick pauses with 'no publisher configured' and leaves the post publishing", async () => {
    const p = post(["linkedin", "x"]);
    const { store, pubs } = memStore(p, [acct("linkedin"), acct("x")]);
    const r = await runPublishTick(T0, { store, resolve: () => null });
    expect(r.published).toBe(0);
    expect(p.status).toBe("publishing");
    expect([...pubs.values()].map((v) => [v.status, v.error])).toEqual([["paused", "no publisher configured"], ["paused", "no publisher configured"]]);
  });

  it("cron refuses GROWTH_PUBLISHER=log on Vercel production", async () => {
    try {
      process.env.VERCEL_ENV = "production"; process.env.GROWTH_PUBLISHER = "log"; process.env.CRON_SECRET = "s";
      const { GET } = await import("@/app/api/cron/growth-publish/route");
      const res = await GET(new Request("http://x", { headers: { authorization: "Bearer s" } }));
      expect(res.status).toBe(503);
    } finally { restore(); }
  });
});
