import "server-only";

import { growthDb, must, type GrowthDb } from "../db.server";
import type { GrowthKeyword, WatchKind, WatchlistEntry } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export function mapWatch(r: Row): WatchlistEntry {
  return {
    id: r.id,
    platform: r.platform,
    handle: r.handle,
    url: r.url ?? null,
    topic: r.topic ?? null,
    kind: r.kind,
    notes: r.notes ?? null,
    active: r.active !== false,
    createdAt: r.created_at,
  };
}

export function mapKeyword(r: Row): GrowthKeyword {
  return { id: r.id, keyword: r.keyword, reply: r.reply ?? null, link: r.link ?? null, active: r.active !== false, createdAt: r.created_at };
}

export async function listWatchlist(kinds: WatchKind[] | null = null, db: GrowthDb = growthDb()): Promise<WatchlistEntry[]> {
  let q = db.from("growth_watchlist").select("*").eq("active", true);
  if (kinds) q = q.in("kind", kinds);
  const rows = must(await q.order("created_at", { ascending: true }), "list watchlist") as Row[];
  return rows.map(mapWatch);
}

export async function listKeywords(db: GrowthDb = growthDb()): Promise<GrowthKeyword[]> {
  const rows = must(await db.from("growth_keywords").select("*").order("created_at", { ascending: true }), "list keywords") as Row[];
  return rows.map(mapKeyword);
}
