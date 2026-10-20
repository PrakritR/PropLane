import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingSchemaError } from "@/lib/one-number/config.server";
import type { SignupRole } from "@/lib/one-number/signup/intent";

/**
 * Where a phone is in signing up by text (`sms_signup_sessions`, service role only). One row per phone; every read treats
 * a missing table as "nothing there" so code can ship before the migration (sign-up by text then simply does not run).
 */
export type SignupStep = "role" | "name" | "business" | "homes" | "trade" | "area" | "home" | "email" | "code" | "done";

export type SignupAnswers = {
  fullName?: string;
  businessName?: string;
  homes?: number;
  trade?: string;
  area?: string;
  home?: string;
  /** A claim only. Stored unverified; never a login (docs/agents/one-number.md § W26). */
  email?: string;
  source?: "explicit" | "implicit" | "vendor_lead";
};

export type SignupSession = {
  phoneKey: string;
  phoneE164: string;
  role: SignupRole | null;
  step: SignupStep;
  answers: SignupAnswers;
  lastSid: string | null;
  lastKind: string | null;
  userId: string | null;
  completedAt: string | null;
  updatedAt: string;
};

/** A conversation untouched this long starts over. */
export const SIGNUP_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const COLUMNS = "phone_key, phone_e164, role, step, answers, last_sid, last_kind, user_id, completed_at, updated_at";
type Row = Record<string, unknown>;

const STEPS: readonly SignupStep[] = ["role", "name", "business", "homes", "trade", "area", "home", "email", "code", "done"];

function toSession(row: Row): SignupSession {
  const answers = row.answers && typeof row.answers === "object" && !Array.isArray(row.answers) ? (row.answers as SignupAnswers) : {};
  const role = row.role === "manager" || row.role === "vendor" || row.role === "resident" ? row.role : null;
  const step = STEPS.find((s) => s === row.step) ?? "role";
  return {
    phoneKey: String(row.phone_key ?? ""),
    phoneE164: String(row.phone_e164 ?? ""),
    role,
    step,
    answers,
    lastSid: typeof row.last_sid === "string" ? row.last_sid : null,
    lastKind: typeof row.last_kind === "string" ? row.last_kind : null,
    userId: typeof row.user_id === "string" ? row.user_id : null,
    completedAt: typeof row.completed_at === "string" ? row.completed_at : null,
    updatedAt: String(row.updated_at ?? ""),
  };
}

/** `available: false` = the table is not there (code running before the migration). */
export async function readSignupSession(db: SupabaseClient, phoneKey: string): Promise<{ available: boolean; session: SignupSession | null }> {
  const { data, error } = await db.from("sms_signup_sessions").select(COLUMNS).eq("phone_key", phoneKey).maybeSingle();
  if (error) return { available: false, session: null };
  return { available: true, session: data ? toSession(data as Row) : null };
}

export function signupSessionExpired(session: SignupSession, now: Date): boolean {
  const updated = Date.parse(session.updatedAt);
  return !Number.isFinite(updated) || now.getTime() - updated > SIGNUP_SESSION_TTL_MS;
}

/** Create or replace the phone's row. */
export async function writeSignupSession(
  db: SupabaseClient,
  input: {
    phoneKey: string;
    phoneE164: string;
    role: SignupRole | null;
    step: SignupStep;
    answers: SignupAnswers;
    lastSid?: string | null;
    lastKind?: string | null;
    userId?: string | null;
    completedAt?: string | null;
    now: Date;
  },
): Promise<boolean> {
  const { error } = await db.from("sms_signup_sessions").upsert(
    {
      phone_key: input.phoneKey,
      phone_e164: input.phoneE164,
      role: input.role,
      step: input.step,
      answers: input.answers,
      last_sid: input.lastSid ?? null,
      last_kind: input.lastKind ?? null,
      user_id: input.userId ?? null,
      completed_at: input.completedAt ?? null,
      updated_at: input.now.toISOString(),
    },
    { onConflict: "phone_key" },
  );
  if (error && !isMissingSchemaError(error)) console.error("signup session write failed", error.code ?? "unknown");
  return !error;
}

export async function deleteSignupSession(db: SupabaseClient, phoneKey: string): Promise<void> {
  await db.from("sms_signup_sessions").delete().eq("phone_key", phoneKey).then(() => undefined, () => undefined);
}
