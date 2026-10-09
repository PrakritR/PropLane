import "server-only";

import { growthDb, mapIdea, must, type GrowthDb } from "./db.server";
import { pickFresh } from "./pick";
import { SEED_IDEAS } from "./seed-ideas";
import type { GrowthAngle, GrowthFormat, GrowthIdea } from "./types";

const RECENT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export async function listIdeas(db: GrowthDb = growthDb()): Promise<GrowthIdea[]> {
  const rows = must(await db.from("growth_ideas").select("*").order("created_at", { ascending: false }), "list ideas");
  return (rows as Record<string, unknown>[]).map(mapIdea);
}

export async function insertIdea(
  input: { title: string; angle: GrowthAngle; format: GrowthFormat; notes?: string | null; weight?: number; source?: GrowthIdea["source"] },
  db: GrowthDb = growthDb(),
): Promise<GrowthIdea> {
  const row = must(
    await db
      .from("growth_ideas")
      .insert({
        title: input.title,
        angle: input.angle,
        format: input.format,
        notes: input.notes ?? null,
        weight: input.weight ?? 1,
        source: input.source ?? "manual",
      })
      .select("*")
      .single(),
    "insert idea",
  );
  return mapIdea(row as Record<string, unknown>);
}

export async function updateIdea(
  id: string,
  patch: { weight?: number; notes?: string | null },
  db: GrowthDb = growthDb(),
): Promise<GrowthIdea> {
  const update: Record<string, unknown> = {};
  if (patch.weight !== undefined) update.weight = patch.weight;
  if (patch.notes !== undefined) update.notes = patch.notes;
  const row = must(await db.from("growth_ideas").update(update).eq("id", id).select("*").single(), "update idea");
  return mapIdea(row as Record<string, unknown>);
}

export async function bumpIdeaUsed(id: string, db: GrowthDb = growthDb()): Promise<void> {
  const cur = must(await db.from("growth_ideas").select("used_count").eq("id", id).single(), "read idea") as { used_count: number };
  must(await db.from("growth_ideas").update({ used_count: (cur.used_count ?? 0) + 1 }).eq("id", id).select("id"), "bump idea");
}

/** Insert the seed set when the table is empty. Idempotent. */
export async function ensureSeedIdeas(db: GrowthDb = growthDb()): Promise<number> {
  const { count, error } = await db.from("growth_ideas").select("id", { count: "exact", head: true });
  if (error) throw new Error(`seed check: ${error.message}`);
  if ((count ?? 0) > 0) return 0;
  must(
    await db.from("growth_ideas").insert(SEED_IDEAS.map((i) => ({ ...i, source: "seed" }))).select("id"),
    "seed ideas",
  );
  return SEED_IDEAS.length;
}

/** Ideas with a non-archived growth_posts row created in the last 14 days. */
export async function recentlyUsedIdeaIds(db: GrowthDb = growthDb(), now: Date = new Date()): Promise<Set<string>> {
  const since = new Date(now.getTime() - RECENT_WINDOW_MS).toISOString();
  const rows = must(
    await db
      .from("growth_posts")
      .select("idea_id")
      .not("idea_id", "is", null)
      .neq("status", "archived")
      .gte("created_at", since),
    "list recent post ideas",
  ) as { idea_id: string }[];
  return new Set(rows.map((r) => r.idea_id));
}

/** Weighted-random pick of `n` distinct ideas, skipping ideas used in the last 14 days (penalised fallback). */
export async function pickIdeas(n: number, db: GrowthDb = growthDb(), rand: () => number = Math.random): Promise<GrowthIdea[]> {
  await ensureSeedIdeas(db);
  const [ideas, recent] = await Promise.all([listIdeas(db), recentlyUsedIdeaIds(db)]);
  return pickFresh(ideas, n, recent, rand);
}
