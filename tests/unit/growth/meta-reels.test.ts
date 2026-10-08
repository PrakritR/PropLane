import { afterEach, describe, expect, it, vi } from "vitest";
import { MetaReelError, publishInstagramReel } from "@/lib/listing-channels/meta/graph.server";
import { metaPublisher } from "@/lib/growth/publishers/meta.server";
import type { GrowthAccount, GrowthPost, PublishInput } from "@/lib/growth/types";

const res = (b: unknown) => ({ ok: true, status: 200, json: async () => b }) as unknown as Response;

function fakeGraph(statuses: string[]) {
  const calls: string[] = [];
  let i = 0;
  const f = vi.fn(async (url: URL | string, init?: RequestInit) => {
    const u = new URL(String(url));
    calls.push(`${init?.method ?? "GET"} ${u.pathname.split("/").slice(2).join("/")}`);
    if (u.pathname.endsWith("/media_publish")) return res({ id: "media-1" });
    if (u.pathname.endsWith("/media")) return res({ id: "cont-1" });
    return res({ status_code: statuses[Math.min(i++, statuses.length - 1)] });
  });
  return { f, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("publishInstagramReel", () => {
  it("creates the container, polls to FINISHED after 2 polls, then publishes", async () => {
    const { f, calls } = fakeGraph(["IN_PROGRESS", "FINISHED"]);
    vi.stubGlobal("fetch", f);
    const id = await publishInstagramReel({ igAccountId: "ig1", token: "t", videoUrl: "https://v/x.mp4", caption: "c" }, { sleep: async () => undefined });
    expect(id).toBe("media-1");
    expect(calls).toEqual(["POST ig1/media", "GET cont-1", "GET cont-1", "POST ig1/media_publish"]);
    const body = String((f.mock.calls[0]![1] as RequestInit).body);
    expect(body).toContain("media_type=REELS");
  });

  it("throws a non-retryable error on ERROR and never publishes", async () => {
    const { f, calls } = fakeGraph(["ERROR"]);
    vi.stubGlobal("fetch", f);
    await expect(publishInstagramReel({ igAccountId: "ig1", token: "t", videoUrl: "u", caption: "c" }, { sleep: async () => undefined })).rejects.toBeInstanceOf(MetaReelError);
    expect(calls.some((c) => c.includes("media_publish"))).toBe(false);
  });

  it("publisher maps ERROR to retryable false and video to the reel path", async () => {
    vi.stubEnv("META_APP_LIVE", "1");
    vi.stubEnv("GROWTH_META_PAGE_TOKEN", "t");
    const { f } = fakeGraph(["ERROR"]);
    vi.stubGlobal("fetch", f);
    const input = {
      post: {} as GrowthPost,
      platform: "instagram",
      account: { vendorAccountId: "ig1" } as GrowthAccount,
      caption: "c",
      media: [{ url: "https://v/x.mp4", kind: "video" }],
    } as PublishInput;
    const r = await metaPublisher.publish(input);
    expect(r).toMatchObject({ ok: false, retryable: false });
  });
});
