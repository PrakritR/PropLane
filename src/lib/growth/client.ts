/**
 * Growth engine - typed browser fetchers for /api/admin/growth/*.
 * Contract: docs/agents/growth-engine.md. Every helper returns a result object and never
 * throws, so a 404/500 renders an error state instead of crashing the tab.
 */
import { fetchWithTimeout } from "@/lib/auth/fetch-with-timeout";
import type {
  GrowthAccount,
  GrowthAsset,
  GrowthFormat,
  GrowthIdea,
  GrowthLearned,
  GrowthPlatform,
  GrowthPost,
  GrowthPostStatus,
  GrowthPublication,
  GrowthPublisherId,
} from "@/lib/growth/types";

const BASE = "/api/admin/growth";
const TIMEOUT_MS = 20_000;

export type GrowthResult<T> = { ok: true; data: T } | { ok: false; error: string; status: number };

/** A post as the list/detail routes return it; publications and assets ride along when the server includes them. */
export type GrowthPostView = GrowthPost & {
  publications?: GrowthPublication[];
  assets?: GrowthAsset[];
};

export type GrowthAnalyticsPostRow = {
  postId: string;
  title: string;
  views: Partial<Record<GrowthPlatform, number>>;
  learned: string | null;
};

export type GrowthAnalytics = {
  totals: {
    followers: number | null;
    views7d: number | null;
    postsPublished30d: number | null;
    linkClicks: number | null;
  };
  posts: GrowthAnalyticsPostRow[];
  learned: GrowthLearned[];
};

async function call<T>(
  path: string,
  init: { method?: string; body?: unknown } = {},
  pick: (json: Record<string, unknown>) => T,
): Promise<GrowthResult<T>> {
  try {
    const res = await fetchWithTimeout(
      `${BASE}${path}`,
      {
        method: init.method ?? "GET",
        headers: init.body !== undefined ? { "content-type": "application/json" } : undefined,
        body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      },
      TIMEOUT_MS,
    );
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      const error = typeof json.error === "string" && json.error ? json.error : `Request failed (${res.status}).`;
      return { ok: false, error, status: res.status };
    }
    return { ok: true, data: pick(json) };
  } catch {
    return { ok: false, error: "Could not reach the server.", status: 0 };
  }
}

function arr<T>(json: Record<string, unknown>, key: string): T[] {
  const v = json[key];
  return Array.isArray(v) ? (v as T[]) : [];
}

function one<T>(json: Record<string, unknown>, key: string): T {
  return (json[key] ?? json) as T;
}

export const growthApi = {
  listPosts: (status?: GrowthPostStatus) =>
    call(`/posts${status ? `?status=${encodeURIComponent(status)}` : ""}`, {}, (j) => arr<GrowthPostView>(j, "posts")),
  createPost: (input: { title: string; format: GrowthFormat; platforms: GrowthPlatform[] }) =>
    call("/posts", { method: "POST", body: input }, (j) => one<GrowthPostView>(j, "post")),
  getPost: (id: string) =>
    call(`/posts/${encodeURIComponent(id)}`, {}, (j): GrowthPostView => ({
      ...one<GrowthPostView>(j, "post"),
      publications: arr<GrowthPublication>(j, "publications"),
    })),
  patchPost: (
    id: string,
    patch: Partial<Pick<GrowthPost, "title" | "hook" | "script" | "captions" | "platforms" | "scheduledFor">>,
  ) => call(`/posts/${encodeURIComponent(id)}`, { method: "PATCH", body: patch }, (j) => one<GrowthPostView>(j, "post")),
  approve: (id: string, scheduledFor?: string | null) =>
    call(`/posts/${encodeURIComponent(id)}/approve`, { method: "POST", body: scheduledFor ? { scheduledFor } : {} }, (j) =>
      one<GrowthPostView>(j, "post"),
    ),
  sendBack: (id: string, note: string) =>
    call(`/posts/${encodeURIComponent(id)}/send-back`, { method: "POST", body: { note } }, (j) => one<GrowthPostView>(j, "post")),
  archive: (id: string) =>
    call(`/posts/${encodeURIComponent(id)}/archive`, { method: "POST", body: {} }, (j) => one<GrowthPostView>(j, "post")),
  regenerate: (id: string) =>
    call(`/posts/${encodeURIComponent(id)}/regenerate`, { method: "POST", body: {} }, (j) => one<GrowthPostView>(j, "post")),
  retryPublication: (id: string) =>
    call(`/publications/${encodeURIComponent(id)}/retry`, { method: "POST", body: {} }, () => true as const),
  listAccounts: () => call("/accounts", {}, (j) => arr<GrowthAccount>(j, "accounts")),
  createAccount: (input: {
    platform: GrowthPlatform;
    handle: string;
    publisher: GrowthPublisherId;
    vendorAccountId?: string | null;
  }) => call("/accounts", { method: "POST", body: input }, (j) => one<GrowthAccount>(j, "account")),
  patchAccount: (id: string, patch: { status: GrowthAccount["status"] }) =>
    call(`/accounts/${encodeURIComponent(id)}`, { method: "PATCH", body: patch }, (j) => one<GrowthAccount>(j, "account")),
  listIdeas: () => call("/ideas", {}, (j) => arr<GrowthIdea>(j, "ideas")),
  analytics: () =>
    call("/analytics", {}, (j): GrowthAnalytics => {
      // Server rows are per publication; fold them into one row per post, and derive the 7d / 30d tiles.
      const rows = arr<{ postId: string; title: string; platform: GrowthPlatform; publishedAt: string | null; views: number | null }>(j, "posts");
      const now = Date.now();
      const within = (iso: string | null, days: number) => !!iso && now - Date.parse(iso) <= days * 86_400_000;
      const byPost = new Map<string, GrowthAnalyticsPostRow>();
      for (const r of rows) {
        const row = byPost.get(r.postId) ?? { postId: r.postId, title: r.title, views: {}, learned: null };
        if (r.views != null) row.views[r.platform] = r.views;
        byPost.set(r.postId, row);
      }
      const recent = rows.filter((r) => within(r.publishedAt, 7));
      return {
        totals: {
          followers: null,
          views7d: rows.length ? recent.reduce((n, r) => n + (r.views ?? 0), 0) : null,
          postsPublished30d: new Set(rows.filter((r) => within(r.publishedAt, 30)).map((r) => r.postId)).size,
          linkClicks: null,
        },
        posts: [...byPost.values()],
        learned: arr<GrowthLearned>(j, "learned"),
      };
    }),
  draftNow: () => call("/draft-now", { method: "POST", body: {} }, () => true as const),
};
