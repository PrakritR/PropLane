import "server-only";

import { growthDb, must, type GrowthDb } from "../db.server";
import type { EngageItem, EngageStatus } from "./types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;

export function mapEngage(r: Row): EngageItem {
  return {
    id: r.id,
    forDate: r.for_date,
    source: r.source,
    platform: r.platform,
    target: r.target,
    url: r.url,
    why: r.why ?? null,
    draft: r.draft ?? null,
    status: r.status,
    evidence: r.evidence ?? {},
    createdAt: r.created_at,
  };
}

export async function listEngageItems(date: string, db: GrowthDb = growthDb()): Promise<EngageItem[]> {
  const rows = must(
    await db.from("growth_engage_items").select("*").eq("for_date", date).order("created_at", { ascending: true }),
    "list engage items",
  ) as Row[];
  return rows.map(mapEngage);
}

export async function patchEngageItem(
  id: string,
  patch: { status?: EngageStatus; draft?: string },
  db: GrowthDb = growthDb(),
): Promise<EngageItem> {
  const res = await db.from("growth_engage_items").update(patch).eq("id", id).select("*").maybeSingle();
  const row = must(res, "update engage item") as Row | null;
  if (!row) throw new Error("Engage item not found");
  return mapEngage(row);
}
