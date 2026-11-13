import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { findRawPropertyIds, noticePlaceName, scrubRawPropertyIds } from "@/lib/notice-place-label";

type PropertyRow = { id?: unknown; property_data?: unknown };

/** The display name of a property record: building name, then title, then street address (never the id). */
export function propertyDisplayNameFromData(data: unknown): string {
  const d = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
  const listing = (d.listingSubmission && typeof d.listingSubmission === "object" ? d.listingSubmission : {}) as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const source of [d, listing]) for (const key of keys) {
      const value = typeof source[key] === "string" ? (source[key] as string).trim() : "";
      if (value) return value;
    }
    return "";
  };
  return noticePlaceName(pick("buildingName"), pick("title"), pick("address"));
}

/** id -> display name for every property id asked; an unreadable record is simply absent (the caller says "your house"). */
export async function loadPropertyDisplayNames(db: SupabaseClient, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const unique = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (unique.length === 0) return out;
  try {
    const { data } = await db.from("manager_property_records").select("id, property_data").in("id", unique);
    for (const row of (data ?? []) as PropertyRow[]) {
      const id = typeof row.id === "string" ? row.id : "";
      if (!id) continue;
      const name = propertyDisplayNameFromData(row.property_data);
      if (name) out.set(id, name);
    }
  } catch {
    /* names are polish; the id is still never shown */
  }
  return out;
}

/** `text` with raw property ids in its prose replaced by the house's display name. A text with no id costs no query. */
export async function withHouseDisplayNames(db: SupabaseClient, text: string): Promise<string> {
  const ids = findRawPropertyIds(text);
  if (ids.length === 0) return text;
  return scrubRawPropertyIds(text, await loadPropertyDisplayNames(db, ids));
}
