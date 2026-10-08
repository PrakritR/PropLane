import "server-only";

import { growthDb, mapAccount, mapAsset, mapPost, mapPublication, must, type GrowthDb } from "./db.server";
import { assertTransition } from "./post-state";
import { resolvePublisher } from "./publishers/index.server";
import type {
  GrowthAccount,
  GrowthAsset,
  GrowthPlatform,
  GrowthPost,
  GrowthPostStatus,
  GrowthPublication,
  GrowthPublisher,
  PublishInput,
} from "./types";

export const MAX_PUBLISH_ATTEMPTS = 3;
const BACKOFF_MINUTES_PER_ATTEMPT = 5;

/** Storage seam so the tick is testable without a database. */
export interface PublishStore {
  duePosts(now: Date): Promise<GrowthPost[]>;
  ensurePublication(post: GrowthPost, platform: GrowthPlatform, publisher: GrowthPublication["publisher"]): Promise<GrowthPublication>;
  updatePublication(id: string, patch: Partial<Omit<GrowthPublication, "id" | "postId" | "platform">>): Promise<void>;
  accountFor(platform: GrowthPlatform): Promise<GrowthAccount | null>;
  assets(postId: string): Promise<GrowthAsset[]>;
  setPost(id: string, status: GrowthPostStatus, patch?: { publishedAt?: string }): Promise<void>;
}

export type PublishTickResult = {
  considered: number;
  published: number;
  failed: number;
  stillPublishing: number;
};

export function backoffElapsed(pub: Pick<GrowthPublication, "attempts" | "lastAttemptAt">, now: Date): boolean {
  if (pub.attempts <= 0 || !pub.lastAttemptAt) return true;
  const due = new Date(pub.lastAttemptAt).getTime() + BACKOFF_MINUTES_PER_ATTEMPT * pub.attempts * 60_000;
  return now.getTime() >= due;
}

export function captionFor(post: GrowthPost, platform: GrowthPlatform): string {
  return post.captions[platform]?.trim() || post.hook?.trim() || post.title;
}

export function mediaFor(assets: GrowthAsset[]): PublishInput["media"] {
  return assets
    .filter((a) => (a.kind === "image" || a.kind === "video") && a.publicUrl)
    .map((a) => ({ url: a.publicUrl, kind: a.kind as "image" | "video", width: a.width, height: a.height }));
}

export async function runPublishTick(
  now: Date = new Date(),
  deps: { store?: PublishStore; resolve?: (account: GrowthAccount | null) => GrowthPublisher } = {},
): Promise<PublishTickResult> {
  const store = deps.store ?? supabasePublishStore();
  const resolve = deps.resolve ?? resolvePublisher;
  const result: PublishTickResult = { considered: 0, published: 0, failed: 0, stillPublishing: 0 };

  for (const post of await store.duePosts(now)) {
    result.considered++;
    if (post.status === "scheduled") {
      assertTransition("scheduled", "publishing");
      await store.setPost(post.id, "publishing");
    }
    const assets = mediaFor(await store.assets(post.id));
    const pubs: GrowthPublication[] = [];

    for (const platform of post.platforms) {
      let pub = await store.ensurePublication(post, platform, resolve(null).id);
      if (pub.status === "published" || (pub.status === "failed" && pub.attempts >= MAX_PUBLISH_ATTEMPTS)) {
        pubs.push(pub);
        continue;
      }
      if (pub.status === "failed") {
        // Retry-route reset or a legacy failed row below the cap: treat as pending.
        pub = { ...pub, status: "pending" };
      }
      const account = await store.accountFor(platform);
      if (!account || account.status === "disconnected" || account.status === "paused") {
        const error = account ? `Account ${account.handle} is ${account.status}` : `No connected ${platform} account`;
        await store.updatePublication(pub.id, { status: "paused", error, accountId: account?.id ?? null });
        pubs.push({ ...pub, status: "paused", error });
        continue;
      }
      if (!backoffElapsed(pub, now)) {
        pubs.push(pub);
        continue;
      }
      const driver = resolve(account);
      const attempts = pub.attempts + 1;
      let outcome: Awaited<ReturnType<GrowthPublisher["publish"]>>;
      try {
        outcome = await driver.publish({ post, platform, account, caption: captionFor(post, platform), media: assets });
      } catch (e) {
        outcome = { ok: false, error: e instanceof Error ? e.message : "publisher threw", retryable: true };
      }
      if (outcome.ok) {
        const patch = {
          status: "published" as const,
          accountId: account.id,
          publisher: driver.id,
          vendorPostId: outcome.vendorPostId,
          platformPostId: outcome.platformPostId,
          platformUrl: outcome.platformUrl,
          error: null,
          attempts,
          lastAttemptAt: now.toISOString(),
          publishedAt: now.toISOString(),
        };
        await store.updatePublication(pub.id, patch);
        pubs.push({ ...pub, ...patch });
      } else {
        const exhausted = !outcome.retryable || attempts >= MAX_PUBLISH_ATTEMPTS;
        const patch = {
          status: exhausted ? ("failed" as const) : ("pending" as const),
          accountId: account.id,
          publisher: driver.id,
          error: outcome.error,
          // A non-retryable failure is exhausted immediately: the cap is what marks a row terminal.
          attempts: exhausted ? Math.max(attempts, MAX_PUBLISH_ATTEMPTS) : attempts,
          lastAttemptAt: now.toISOString(),
        };
        await store.updatePublication(pub.id, patch);
        pubs.push({ ...pub, ...patch });
      }
    }

    const active = pubs.filter((p) => p.status !== "paused");
    if (active.some((p) => p.status === "failed" && p.attempts >= MAX_PUBLISH_ATTEMPTS)) {
      await store.setPost(post.id, "failed");
      result.failed++;
    } else if (active.length > 0 && active.every((p) => p.status === "published")) {
      await store.setPost(post.id, "published", { publishedAt: now.toISOString() });
      result.published++;
    } else {
      result.stillPublishing++;
    }
  }
  return result;
}

export function supabasePublishStore(db: GrowthDb = growthDb()): PublishStore {
  return {
    async duePosts(now) {
      const rows = must(
        await db
          .from("growth_posts")
          .select("*")
          .or(`and(status.eq.scheduled,scheduled_for.lte.${now.toISOString()}),status.eq.publishing`)
          .order("scheduled_for", { ascending: true })
          .limit(50),
        "due posts",
      );
      return (rows as Record<string, unknown>[]).map(mapPost);
    },
    async ensurePublication(post, platform, publisher) {
      await db
        .from("growth_publications")
        .upsert({ post_id: post.id, platform, publisher }, { onConflict: "post_id,platform", ignoreDuplicates: true });
      const row = must(
        await db.from("growth_publications").select("*").eq("post_id", post.id).eq("platform", platform).single(),
        "load publication",
      );
      return mapPublication(row as Record<string, unknown>);
    },
    async updatePublication(id, patch) {
      const map: Record<string, string> = {
        accountId: "account_id", vendorPostId: "vendor_post_id", platformPostId: "platform_post_id",
        platformUrl: "platform_url", lastAttemptAt: "last_attempt_at", publishedAt: "published_at",
      };
      const row: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(patch)) row[map[k] ?? k] = v;
      must(await db.from("growth_publications").update(row).eq("id", id).select("id"), "update publication");
    },
    async accountFor(platform) {
      const rows = must(
        await db
          .from("growth_accounts")
          .select("*")
          .eq("platform", platform)
          .order("created_at", { ascending: true }),
        "accounts",
      ) as Record<string, unknown>[];
      const accounts = rows.map(mapAccount);
      return accounts.find((a) => a.status === "connected" || a.status === "expiring") ?? accounts[0] ?? null;
    },
    async assets(postId) {
      const rows = must(await db.from("growth_assets").select("*").eq("post_id", postId).order("created_at"), "assets");
      return (rows as Record<string, unknown>[]).map(mapAsset);
    },
    async setPost(id, status, patch) {
      const cur = must(await db.from("growth_posts").select("status").eq("id", id).single(), "read post") as { status: GrowthPostStatus };
      if (cur.status !== status) assertTransition(cur.status, status);
      const row: Record<string, unknown> = { status };
      if (patch?.publishedAt) row.published_at = patch.publishedAt;
      must(await db.from("growth_posts").update(row).eq("id", id).select("id"), "set post status");
    },
  };
}
