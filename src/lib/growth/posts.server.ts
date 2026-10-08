import "server-only";

import { growthDb, mapPost, mapPublication, must, type GrowthDb } from "./db.server";
import { regeneratePostDraft } from "./draft.server";
import { assertTransition } from "./post-state";
import { nextFreeSlot } from "./slots";
import {
  GROWTH_FORMATS,
  GROWTH_PLATFORMS,
  GROWTH_POST_STATUSES,
  type GrowthCaptions,
  type GrowthFormat,
  type GrowthPlatform,
  type GrowthPost,
  type GrowthPostStatus,
  type GrowthPublication,
  type GrowthScene,
} from "./types";

export function isPostStatus(v: unknown): v is GrowthPostStatus {
  return typeof v === "string" && (GROWTH_POST_STATUSES as readonly string[]).includes(v);
}

export async function listPosts(status?: GrowthPostStatus, db: GrowthDb = growthDb()): Promise<GrowthPost[]> {
  let q = db.from("growth_posts").select("*").order("created_at", { ascending: false }).limit(200);
  if (status) q = q.eq("status", status);
  return (must(await q, "list posts") as Record<string, unknown>[]).map(mapPost);
}

export async function getPost(id: string, db: GrowthDb = growthDb()): Promise<GrowthPost | null> {
  const { data, error } = await db.from("growth_posts").select("*").eq("id", id).maybeSingle();
  if (error) throw new Error(`get post: ${error.message}`);
  return data ? mapPost(data as Record<string, unknown>) : null;
}

export async function listPublications(postId: string, db: GrowthDb = growthDb()): Promise<GrowthPublication[]> {
  const rows = must(await db.from("growth_publications").select("*").eq("post_id", postId), "list publications");
  return (rows as Record<string, unknown>[]).map(mapPublication);
}

export async function createManualPost(
  input: { title: string; format: GrowthFormat; platforms: GrowthPlatform[] },
  db: GrowthDb = growthDb(),
): Promise<GrowthPost> {
  const row = must(
    await db
      .from("growth_posts")
      .insert({ title: input.title, format: input.format, platforms: input.platforms, status: "drafted", created_by: "admin" })
      .select("*")
      .single(),
    "create post",
  );
  return mapPost(row as Record<string, unknown>);
}

export type PostPatch = {
  title?: string;
  hook?: string | null;
  script?: string | null;
  scenes?: GrowthScene[];
  captions?: GrowthCaptions;
  platforms?: GrowthPlatform[];
  scheduledFor?: string | null;
};

export async function patchPost(id: string, patch: PostPatch, db: GrowthDb = growthDb()): Promise<GrowthPost> {
  const row: Record<string, unknown> = {};
  if (patch.title !== undefined) row.title = patch.title;
  if (patch.hook !== undefined) row.hook = patch.hook;
  if (patch.script !== undefined) row.script = patch.script;
  if (patch.scenes !== undefined) row.scenes = patch.scenes;
  if (patch.captions !== undefined) row.captions = patch.captions;
  if (patch.platforms !== undefined) row.platforms = patch.platforms;
  if (patch.scheduledFor !== undefined) row.scheduled_for = patch.scheduledFor;
  const data = must(await db.from("growth_posts").update(row).eq("id", id).select("*").maybeSingle(), "patch post");
  if (!data) throw new Error("Post not found");
  return mapPost(data as Record<string, unknown>);
}

async function requirePost(id: string, db: GrowthDb): Promise<GrowthPost> {
  const post = await getPost(id, db);
  if (!post) throw new Error("Post not found");
  return post;
}

/** Approve: review/approved → scheduled with approvedAt/approvedBy from the admin session. */
export async function approvePost(
  id: string,
  adminUserId: string,
  scheduledFor?: string | null,
  db: GrowthDb = growthDb(),
  now: Date = new Date(),
): Promise<GrowthPost> {
  const post = await requirePost(id, db);
  assertTransition(post.status, "scheduled");
  if (post.platforms.length === 0) throw new Error("Post has no platforms");
  let when = scheduledFor ?? post.scheduledFor;
  if (!when || new Date(when).getTime() <= now.getTime()) {
    const taken = must(
      await db.from("growth_posts").select("scheduled_for").in("status", ["scheduled", "publishing"]).not("scheduled_for", "is", null),
      "taken slots",
    ) as Array<{ scheduled_for: string }>;
    when = scheduledFor ?? nextFreeSlot(now, post.format, post.platforms, taken.map((t) => t.scheduled_for)).toISOString();
  }
  if (Number.isNaN(new Date(when).getTime())) throw new Error("Invalid scheduledFor");
  const row = must(
    await db
      .from("growth_posts")
      .update({ status: "scheduled", approved_at: now.toISOString(), approved_by: adminUserId, scheduled_for: when })
      .eq("id", id)
      .select("*")
      .single(),
    "approve post",
  );
  return mapPost(row as Record<string, unknown>);
}

export async function sendBackPost(id: string, note: string, db: GrowthDb = growthDb()): Promise<GrowthPost> {
  const post = await requirePost(id, db);
  assertTransition(post.status, "drafted");
  const row = must(
    await db.from("growth_posts").update({ status: "drafted", review_note: note, approved_at: null, approved_by: null }).eq("id", id).select("*").single(),
    "send back",
  );
  return mapPost(row as Record<string, unknown>);
}

export async function archivePost(id: string, db: GrowthDb = growthDb()): Promise<GrowthPost> {
  const post = await requirePost(id, db);
  assertTransition(post.status, "archived");
  const row = must(await db.from("growth_posts").update({ status: "archived" }).eq("id", id).select("*").single(), "archive");
  return mapPost(row as Record<string, unknown>);
}

export async function regeneratePost(id: string, db: GrowthDb = growthDb()): Promise<GrowthPost> {
  const post = await requirePost(id, db);
  if (post.status !== "review" && post.status !== "drafted") {
    throw new Error(`Cannot regenerate a post in status ${post.status}`);
  }
  return regeneratePostDraft(post, db);
}

/** Reset one publication for another round of attempts and put its post back in the publish queue. */
export async function retryPublication(id: string, db: GrowthDb = growthDb()): Promise<GrowthPublication> {
  const pub = must(await db.from("growth_publications").select("*").eq("id", id).maybeSingle(), "load publication") as Record<string, unknown> | null;
  if (!pub) throw new Error("Publication not found");
  const row = must(
    await db.from("growth_publications").update({ status: "pending", attempts: 0, error: null, last_attempt_at: null }).eq("id", id).select("*").single(),
    "reset publication",
  );
  const post = await requirePost(String(pub.post_id), db);
  if (post.status === "failed") {
    assertTransition("failed", "publishing");
    must(await db.from("growth_posts").update({ status: "publishing" }).eq("id", post.id).select("id"), "requeue post");
  }
  return mapPublication(row as Record<string, unknown>);
}

export { GROWTH_FORMATS, GROWTH_PLATFORMS };
