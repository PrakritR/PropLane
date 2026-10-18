import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingSchemaError } from "@/lib/one-number/config.server";
import { DEMO_IDLE_MINUTES, type DemoChannel, type DemoHints, type DemoState, type DemoStep } from "@/lib/one-number/demo/types";

/**
 * `sms_demo_sessions`: the ONLY thing the demo persists (plus its finish-setup link). One live row per
 * (channel, session key). A session idle past `DEMO_IDLE_MINUTES` is closed on read.
 */
export type DemoSessionRow = { id: string; state: DemoState; updatedAt: string };

type Row = Record<string, unknown>;
const STEPS: readonly DemoStep[] = ["applicant", "leak", "rent", "ask_address", "ask_rooms", "ask_rent", "finished", "ended"];

function toSession(row: Row): DemoSessionRow {
  const ctx = row.context && typeof row.context === "object" && !Array.isArray(row.context) ? (row.context as Row) : {};
  const hintsRaw = ctx.hints && typeof ctx.hints === "object" ? (ctx.hints as Row) : {};
  const hints: DemoHints = {};
  if (typeof hintsRaw.address === "string" && hintsRaw.address) hints.address = hintsRaw.address;
  if (typeof hintsRaw.rooms === "number") hints.rooms = hintsRaw.rooms;
  if (typeof hintsRaw.rent === "number") hints.rent = hintsRaw.rent;
  const step = STEPS.includes(row.step as DemoStep) ? (row.step as DemoStep) : "applicant";
  return {
    id: String(row.id ?? ""),
    state: { step, hints, strikes: typeof ctx.strikes === "number" ? ctx.strikes : 0 },
    updatedAt: String(row.updated_at ?? ""),
  };
}

const contextOf = (state: DemoState) => ({ hints: state.hints, strikes: state.strikes });

/** The live session for this key, or null. An idle one is closed and reads as null. */
export async function loadLiveDemoSession(db: SupabaseClient, channel: DemoChannel, sessionKey: string, now: Date): Promise<DemoSessionRow | null> {
  const { data, error } = await db
    .from("sms_demo_sessions")
    .select("id, step, context, updated_at")
    .eq("channel", channel)
    .eq("session_key", sessionKey)
    .is("finished_at", null)
    .maybeSingle();
  if (error || !data) return null;
  const session = toSession(data as Row);
  const idleMs = now.getTime() - new Date(session.updatedAt).getTime();
  if (Number.isFinite(idleMs) && idleMs > DEMO_IDLE_MINUTES * 60 * 1000) {
    await db.from("sms_demo_sessions").update({ finished_at: now.toISOString(), updated_at: now.toISOString() }).eq("id", session.id);
    return null;
  }
  return session;
}

/** Start a session, closing any live one for the same key first (a restart). Null when it cannot be stored. */
export async function createDemoSession(
  db: SupabaseClient,
  input: { channel: DemoChannel; sessionKey: string; state: DemoState; now: Date },
): Promise<DemoSessionRow | null> {
  const at = input.now.toISOString();
  await db
    .from("sms_demo_sessions")
    .update({ finished_at: at, updated_at: at })
    .eq("channel", input.channel)
    .eq("session_key", input.sessionKey)
    .is("finished_at", null);
  const { data, error } = await db
    .from("sms_demo_sessions")
    .insert({
      channel: input.channel,
      session_key: input.sessionKey,
      phone_key: input.channel === "sms" ? input.sessionKey : null,
      step: input.state.step,
      context: contextOf(input.state),
      started_at: at,
      updated_at: at,
    })
    .select("id, step, context, updated_at")
    .maybeSingle();
  if (error || !data) {
    if (error && !isMissingSchemaError(error)) console.error("demo session create failed", error.code ?? "unknown");
    return null;
  }
  return toSession(data as Row);
}

export async function saveDemoSession(db: SupabaseClient, id: string, state: DemoState, now: Date, opts: { finish?: boolean } = {}): Promise<boolean> {
  const at = now.toISOString();
  const { error } = await db
    .from("sms_demo_sessions")
    .update({ step: state.step, context: contextOf(state), updated_at: at, ...(opts.finish ? { finished_at: at } : {}) })
    .eq("id", id);
  return !error;
}

/** STOP (or any end) closes every live demo for a phone. Best effort: it never throws. */
export async function endDemoForPhone(db: SupabaseClient, phoneKey: string, now: Date = new Date()): Promise<void> {
  try {
    const at = now.toISOString();
    await db.from("sms_demo_sessions").update({ step: "ended", finished_at: at, updated_at: at }).eq("channel", "sms").eq("session_key", phoneKey).is("finished_at", null);
  } catch {
    /* STOP handling must never fail on the demo */
  }
}

/** Is this phone mid-demo right now? */
export async function hasLiveDemo(db: SupabaseClient, phoneKey: string, now: Date = new Date()): Promise<boolean> {
  return (await loadLiveDemoSession(db, "sms", phoneKey, now)) !== null;
}
