import "server-only";

import { growthDb, mapMetric, mapPublication, must, type GrowthDb } from "./db.server";
import { allPublishers } from "./publishers/index.server";
import type { GrowthMetric, GrowthPublication } from "./types";

const DAY_MS = 86_400_000;
export const BEAT_MEDIAN_FACTOR = 1.5;
/** Metrics are only pulled for publications published inside this window... */
export const INSIGHTS_WINDOW_DAYS = 30;
/** ...and at most this many per publisher per tick, newest first, so the cron stays inside its time budget. */
export const INSIGHTS_MAX_PER_TICK = 50;

export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function nextWeight(weight: number, outcome: "beat" | "under" | "flat"): number {
  if (outcome === "beat") return Math.min(3, Math.round(weight * 1.2 * 1000) / 1000);
  if (outcome === "under") return Math.max(0.3, Math.round(weight * 0.9 * 1000) / 1000);
  return weight;
}

export async function runInsightsTick(db: GrowthDb = growthDb(), now: Date = new Date()) {
  const windowStart = new Date(now.getTime() - INSIGHTS_WINDOW_DAYS * DAY_MS);
  const rows = must(
    await db
      .from("growth_publications")
      .select("*")
      .eq("status", "published")
      .gte("published_at", windowStart.toISOString())
      .order("published_at", { ascending: false }),
    "published publications",
  ) as Record<string, unknown>[];
  const pubs = rows.map(mapPublication);
  let stored = 0;
  for (const driver of allPublishers()) {
    if (!driver.fetchMetrics) continue;
    const mine = pubs.filter((p) => p.publisher === driver.id).slice(0, INSIGHTS_MAX_PER_TICK);
    if (mine.length === 0) continue;
    const metrics = await driver.fetchMetrics(mine);
    if (metrics.length === 0) continue;
    must(
      await db
        .from("growth_metrics")
        .insert(
          metrics.map((m) => ({
            publication_id: m.publicationId,
            captured_at: m.capturedAt,
            views: m.views,
            likes: m.likes,
            comments: m.comments,
            shares: m.shares,
            saves: m.saves,
            followers_snapshot: m.followersSnapshot,
            raw: m.raw,
          })),
        )
        .select("id"),
      "insert metrics",
    );
    stored += metrics.length;
  }
  const learn = await learnFromMetrics(db, pubs, now);
  return { stored, ...learn };
}

/** Latest views per publication, for publications with >= 2 metric rows. */
async function latestViews(db: GrowthDb, pubs: GrowthPublication[], since: Date) {
  if (pubs.length === 0) return new Map<string, { views: number; count: number }>();
  const rows = must(
    await db
      .from("growth_metrics")
      .select("*")
      .in("publication_id", pubs.map((p) => p.id))
      .gte("captured_at", since.toISOString())
      .order("captured_at", { ascending: true }),
    "metrics",
  ) as Record<string, unknown>[];
  const out = new Map<string, { views: number; count: number }>();
  for (const m of rows.map(mapMetric) as GrowthMetric[]) {
    const cur = out.get(m.publicationId) ?? { views: 0, count: 0 };
    out.set(m.publicationId, { views: m.views ?? cur.views, count: cur.count + 1 });
  }
  return out;
}

/**
 * Learn stub: for each post with >= 2 metric rows whose views clearly beat the 30-day median x1.5,
 * write one growth_learned line (with evidence) and nudge the source idea's weight. Underperformers
 * (below half the median) nudge down. Idempotent per post via evidence.postId.
 */
export async function learnFromMetrics(db: GrowthDb, pubs: GrowthPublication[], now: Date) {
  const since = new Date(now.getTime() - 30 * DAY_MS);
  const recent = pubs.filter((p) => p.publishedAt && new Date(p.publishedAt) >= since);
  const views = await latestViews(db, recent, since);
  const med = median([...views.values()].map((v) => v.views));
  const byPost = new Map<string, number>();
  const eligible = new Set<string>();
  for (const p of recent) {
    const v = views.get(p.id);
    if (!v) continue;
    byPost.set(p.postId, Math.max(byPost.get(p.postId) ?? 0, v.views));
    if (v.count >= 2) eligible.add(p.postId);
  }
  let lines = 0;
  let reweighted = 0;
  for (const [postId, v] of byPost) {
    if (!eligible.has(postId) || med <= 0) continue;
    const outcome = v >= med * BEAT_MEDIAN_FACTOR ? "beat" : v < med * 0.5 ? "under" : "flat";
    if (outcome === "flat") continue;
    const post = (await db.from("growth_posts").select("id,title,format,idea_id").eq("id", postId).maybeSingle()).data as
      | { id: string; title: string; format: string; idea_id: string | null }
      | null;
    if (!post) continue;
    if (outcome === "beat") {
      const seen = (await db.from("growth_learned").select("id").contains("evidence", { postId }).limit(1)).data ?? [];
      if (seen.length === 0) {
        must(
          await db
            .from("growth_learned")
            .insert({
              line: `"${post.title}" (${post.format}) drew ${v} views, over 1.5x the 30-day median of ${med}.`,
              evidence: { postId, views: v, median30d: med, factor: BEAT_MEDIAN_FACTOR },
            })
            .select("id"),
          "insert learned",
        );
        lines++;
      }
    }
    if (post.idea_id) {
      const idea = (await db.from("growth_ideas").select("id,weight").eq("id", post.idea_id).maybeSingle()).data as
        | { id: string; weight: number }
        | null;
      if (idea) {
        must(
          await db.from("growth_ideas").update({ weight: nextWeight(Number(idea.weight), outcome) }).eq("id", idea.id).select("id"),
          "reweight idea",
        );
        reweighted++;
      }
    }
  }
  return { learnedLines: lines, reweighted };
}
