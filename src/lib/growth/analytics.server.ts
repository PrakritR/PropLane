import "server-only";

import { growthDb, mapLearned, mapMetric, mapPost, mapPublication, must, type GrowthDb } from "./db.server";

export async function loadAnalytics(db: GrowthDb = growthDb()) {
  const pubs = (must(await db.from("growth_publications").select("*").eq("status", "published"), "pubs") as Record<string, unknown>[]).map(mapPublication);
  const ids = pubs.map((p) => p.id);
  const metrics = ids.length
    ? (must(await db.from("growth_metrics").select("*").in("publication_id", ids).order("captured_at"), "metrics") as Record<string, unknown>[]).map(mapMetric)
    : [];
  const postIds = [...new Set(pubs.map((p) => p.postId))];
  const posts = postIds.length
    ? (must(await db.from("growth_posts").select("*").in("id", postIds), "posts") as Record<string, unknown>[]).map(mapPost)
    : [];
  const latest = new Map<string, (typeof metrics)[number]>();
  for (const m of metrics) latest.set(m.publicationId, m);
  const rows = pubs.map((p) => {
    const m = latest.get(p.id);
    const post = posts.find((x) => x.id === p.postId);
    return {
      publicationId: p.id,
      postId: p.postId,
      title: post?.title ?? "",
      platform: p.platform,
      publishedAt: p.publishedAt,
      platformUrl: p.platformUrl,
      views: m?.views ?? null,
      likes: m?.likes ?? null,
      comments: m?.comments ?? null,
      shares: m?.shares ?? null,
      saves: m?.saves ?? null,
    };
  });
  const sum = (k: "views" | "likes" | "comments" | "shares" | "saves") => rows.reduce((s, r) => s + (r[k] ?? 0), 0);
  const learned = (must(await db.from("growth_learned").select("*").order("created_at", { ascending: false }).limit(50), "learned") as Record<string, unknown>[]).map(mapLearned);
  return {
    totals: { posts: postIds.length, publications: pubs.length, views: sum("views"), likes: sum("likes"), comments: sum("comments"), shares: sum("shares"), saves: sum("saves") },
    posts: rows,
    learned,
  };
}
