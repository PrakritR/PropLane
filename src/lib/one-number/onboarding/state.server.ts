import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingSchemaError } from "@/lib/one-number/config.server";
import type { HouseHints, OnboardingRole } from "@/lib/one-number/onboarding/role-detect";

/**
 * What an unknown number has told us about itself (`sms_onboarding_state`): its role, whether we
 * already asked, and the house details a landlord volunteered. Every read treats a missing table as
 * "nothing there" so code can ship before the migration.
 */
export type OnboardingState = {
  phoneKey: string;
  role: OnboardingRole | null;
  askedAt: string | null;
  /**
   * WHICH line asked: `SHARED_LINE_ASK` for the PropLane line, else the E.164 work number. The role question is
   * asked once per line, not once per phone, so every reader compares this with its own number
   * (`askedByLine`). Null on a row written before the column existed.
   */
  askedLine: string | null;
  /** Where a landlord is: `offered` (sample house offered) or `finish_sent` (setup link sent). */
  stage: "offered" | "finish_sent" | null;
  hints: HouseHints;
};

/** `asked_line` for the one PropLane line (it has no per-workspace number to name). */
export const SHARED_LINE_ASK = "shared";

/**
 * Did THIS line ask? A row from before `asked_line` existed answers yes to whoever reads it, which is the
 * behaviour it was written under; a row that names another line never suppresses this one's question.
 */
export function askedByLine(state: OnboardingState | null, line: string | null | undefined): boolean {
  if (!state?.askedAt) return false;
  if (!state.askedLine) return true;
  return state.askedLine === (line ?? "").trim();
}

type Row = Record<string, unknown>;

function toState(row: Row): OnboardingState {
  const hintsRaw = row.hints && typeof row.hints === "object" && !Array.isArray(row.hints) ? (row.hints as Row) : {};
  const hints: HouseHints = {};
  if (typeof hintsRaw.address === "string" && hintsRaw.address) hints.address = hintsRaw.address;
  if (typeof hintsRaw.rooms === "number") hints.rooms = hintsRaw.rooms;
  if (typeof hintsRaw.rent === "number") hints.rent = hintsRaw.rent;
  const role = row.role === "searcher" || row.role === "landlord" || row.role === "vendor" ? row.role : null;
  return {
    phoneKey: String(row.phone_key ?? ""),
    role,
    askedAt: row.asked_at ? String(row.asked_at) : null,
    askedLine: row.asked_line ? String(row.asked_line) : null,
    stage: row.stage === "offered" || row.stage === "finish_sent" ? row.stage : null,
    hints,
  };
}

/**
 * `available: false` = the table is not there (code running before the migration): the caller then
 * skips onboarding entirely and the unknown-sender path behaves exactly as it did before.
 */
const COLUMNS = "phone_key, role, asked_at, asked_line, stage, hints";
const LEGACY_COLUMNS = "phone_key, role, asked_at, stage, hints";

export async function readOnboardingState(db: SupabaseClient, phoneKey: string): Promise<{ available: boolean; state: OnboardingState | null }> {
  const { data, error } = await db.from("sms_onboarding_state").select(COLUMNS).eq("phone_key", phoneKey).maybeSingle();
  if (!error) return { available: true, state: data ? toState(data as Row) : null };
  // `asked_line` landed after the table: a database without it still reads everything else, so onboarding keeps
  // running (per-phone, as it was) instead of switching itself off.
  if (!isMissingSchemaError(error)) return { available: false, state: null };
  const legacy = await db.from("sms_onboarding_state").select(LEGACY_COLUMNS).eq("phone_key", phoneKey).maybeSingle();
  if (legacy.error) return { available: false, state: null };
  return { available: true, state: legacy.data ? toState(legacy.data as Row) : null };
}

export async function loadOnboardingState(db: SupabaseClient, phoneKey: string): Promise<OnboardingState | null> {
  return (await readOnboardingState(db, phoneKey)).state;
}

/** Merge a patch into the phone's row, creating it. Returns false when nothing could be stored. */
export async function saveOnboardingState(
  db: SupabaseClient,
  phoneKey: string,
  patch: { role?: OnboardingRole | null; askedAt?: string | null; askedLine?: string | null; stage?: OnboardingState["stage"]; hints?: HouseHints },
  now: Date = new Date(),
): Promise<boolean> {
  const current = await loadOnboardingState(db, phoneKey);
  const row = {
    phone_key: phoneKey,
    role: patch.role !== undefined ? patch.role : (current?.role ?? null),
    asked_at: patch.askedAt !== undefined ? patch.askedAt : (current?.askedAt ?? null),
    asked_line: patch.askedLine !== undefined ? patch.askedLine : (current?.askedLine ?? null),
    stage: patch.stage !== undefined ? patch.stage : (current?.stage ?? null),
    hints: { ...(current?.hints ?? {}), ...(patch.hints ?? {}) },
    updated_at: now.toISOString(),
  };
  const { error } = await db.from("sms_onboarding_state").upsert(row, { onConflict: "phone_key" });
  if (!error) return true;
  if (isMissingSchemaError(error)) {
    // Either the table is not there at all, or only `asked_line` is: retry without it so the ask is still recorded.
    const { asked_line: _askedLine, ...legacy } = row;
    const retry = await db.from("sms_onboarding_state").upsert(legacy, { onConflict: "phone_key" });
    return !retry.error;
  }
  console.error("onboarding state write failed", error.code ?? "unknown");
  return false;
}
