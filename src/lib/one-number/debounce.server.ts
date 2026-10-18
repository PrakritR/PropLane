import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Burst debounce for agent replies: wait for the texter to finish.
 *
 * Someone texting "hey", "quick question", "is the wifi down" in three bursts
 * should get ONE answer to all three, 1.5 s after the last. Every inbound
 * registers its text in `sms_reply_debounce` (a revision per text), sleeps the
 * quiet window, then asks to claim:
 *   - it is still the newest revision  -> it answers, with every text so far
 *     merged (oldest first), and settles them once its reply is durable;
 *   - a newer text arrived             -> it yields (no reply); the newer
 *     invocation answers for both.
 *
 * Prospects keep their own durable burst queue (`prospect-sms-burst*.ts`, QStash
 * and a revision fence); this is the same revision-fence idea, in one table,
 * for the roles that answer inside the webhook (manager, resident, vendor).
 *
 * Fail-open: any RPC problem (migration not run, a blip) answers at once with
 * just this text. A debounce can delay a reply; it must never lose one.
 */

export type DebounceRole = "manager" | "resident" | "vendor";

export type DebounceOutcome =
  | { proceed: true; body: string; mergedCount: number; waitedMs: number; settle: () => Promise<void> }
  | { proceed: false };

type Entry = { sid: string; body: string; rev: number };

const noSettle = async () => {};

export function debounceScopeKey(args: { ownerUserId: string; role: DebounceRole; phone: string }): string {
  return `${args.ownerUserId}:${args.role}:${args.phone.replace(/\D/g, "")}`;
}

function parseEntries(raw: unknown): Entry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => item as Record<string, unknown>)
    .filter((item) => typeof item?.sid === "string" && typeof item?.body === "string")
    .map((item) => ({ sid: String(item.sid), body: String(item.body), rev: Number(item.rev) || 0 }))
    .sort((a, b) => a.rev - b.rev);
}

export async function debounceInbound(
  db: SupabaseClient,
  args: {
    ownerUserId: string;
    role: DebounceRole;
    phone: string;
    messageSid: string;
    body: string;
    /** Quiet window. 0 disables the wait (and the merge). */
    waitMs: number;
    /** Register and merge, but do not wait (a text carrying a photo answers at once). */
    immediate?: boolean;
    sleep?: (ms: number) => Promise<void>;
  },
): Promise<DebounceOutcome> {
  const own = (waitedMs = 0): DebounceOutcome => ({ proceed: true, body: args.body, mergedCount: 1, waitedMs, settle: noSettle });
  if (!(args.waitMs > 0) || !args.messageSid.trim()) return own();
  const scope = debounceScopeKey(args);
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let rev: number;
  try {
    const { data, error } = await db.rpc("sms_debounce_register", { p_scope: scope, p_sid: args.messageSid, p_body: args.body });
    rev = Number(data);
    if (error || !Number.isFinite(rev) || rev < 1) return own();
  } catch {
    return own();
  }
  let waitedMs = 0;
  if (!args.immediate) {
    await sleep(args.waitMs);
    waitedMs = args.waitMs;
  }
  try {
    const { data, error } = await db.rpc("sms_debounce_claim", { p_scope: scope, p_rev: rev });
    if (error) return own(waitedMs);
    const settle = async () => {
      try {
        await db.rpc("sms_debounce_settle", { p_scope: scope, p_rev: rev });
      } catch {
        /* the entries expire on the next register */
      }
    };
    if (data === null || data === undefined) {
      // Superseded, or the row is gone. Only a strictly newer revision yields.
      const { data: row } = await db.from("sms_reply_debounce").select("revision").eq("scope_key", scope).maybeSingle();
      const newest = Number((row as { revision?: unknown } | null)?.revision);
      if (Number.isFinite(newest) && newest > rev) return { proceed: false };
      return own(waitedMs);
    }
    const entries = parseEntries(data);
    if (entries.length === 0) return own(waitedMs);
    return {
      proceed: true,
      body: entries.map((entry) => entry.body.trim()).filter(Boolean).join("\n") || args.body,
      mergedCount: entries.length,
      waitedMs,
      settle,
    };
  } catch {
    return own(waitedMs);
  }
}
