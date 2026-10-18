import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { readSharedLineConfig, sharedLineActiveFor } from "@/lib/one-number/shared-line-number.server";

/**
 * The "feel" switches of the one-number build: reply bubbles, the resident fast
 * path and the burst debounce. Defaults are ON for the shared line and OFF for a
 * work number, so a workspace on `per_workspace` behaves exactly as before.
 * `sms_runtime_config.feel_settings` may override either lane:
 *
 *   { "shared": { "bubbleReplies": false }, "work": { "debounceMs": 1500 } }
 *
 * Every read is tolerant: an error, a missing column (migration not run) or an
 * odd value falls back to the defaults.
 */

export type FeelSettings = {
  /** Split an agent reply into up to three short bubbles sent 500-800 ms apart. */
  bubbleReplies: boolean;
  /** Answer top resident house-fact questions from facts, no model. */
  residentFastPath: boolean;
  /** Wait this long after the last inbound before replying (0 = reply at once). */
  debounceMs: number;
};

export const SHARED_LINE_FEEL: FeelSettings = { bubbleReplies: true, residentFastPath: true, debounceMs: 1500 };
export const WORK_NUMBER_FEEL: FeelSettings = { bubbleReplies: false, residentFastPath: false, debounceMs: 0 };

const CACHE_TTL_MS = 15_000;
let cached: { at: number; overrides: unknown } | null = null;

export function resetFeelSettingsCacheForTests(): void {
  cached = null;
}

async function readOverrides(db: SupabaseClient): Promise<unknown> {
  const now = Date.now();
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.overrides;
  let overrides: unknown = null;
  try {
    const { data, error } = await db.from("sms_runtime_config").select("feel_settings").eq("singleton", true).maybeSingle();
    if (!error && data) overrides = (data as { feel_settings?: unknown }).feel_settings ?? null;
  } catch {
    overrides = null;
  }
  cached = { at: now, overrides };
  return overrides;
}

/** Apply one lane's override object onto its defaults. Wrong types are ignored. */
export function mergeFeelOverride(base: FeelSettings, raw: unknown): FeelSettings {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const o = raw as Record<string, unknown>;
  const debounce = typeof o.debounceMs === "number" && Number.isFinite(o.debounceMs) ? Math.min(5000, Math.max(0, Math.round(o.debounceMs))) : base.debounceMs;
  return {
    bubbleReplies: typeof o.bubbleReplies === "boolean" ? o.bubbleReplies : base.bubbleReplies,
    residentFastPath: typeof o.residentFastPath === "boolean" ? o.residentFastPath : base.residentFastPath,
    debounceMs: debounce,
  };
}

/**
 * Settings for a text about `workspaceId`. `sharedLine` skips the line-mode read
 * when the caller already knows (the inbound pipeline does).
 */
export async function loadFeelSettings(
  db: SupabaseClient,
  args: { workspaceId?: string | null; sharedLine?: boolean },
): Promise<FeelSettings & { lane: "shared" | "work" }> {
  let shared = args.sharedLine;
  if (shared === undefined) {
    try {
      shared = sharedLineActiveFor(await readSharedLineConfig(db), args.workspaceId ?? null);
    } catch {
      shared = false;
    }
  }
  const overrides = await readOverrides(db);
  const lane = shared ? "shared" : "work";
  const laneOverride = overrides && typeof overrides === "object" ? (overrides as Record<string, unknown>)[lane] : null;
  const merged = mergeFeelOverride(shared ? SHARED_LINE_FEEL : WORK_NUMBER_FEEL, laneOverride);
  return { ...merged, lane };
}
