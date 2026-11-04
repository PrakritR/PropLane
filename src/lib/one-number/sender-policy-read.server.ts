import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/** One uncached, fail-closed canonical policy evaluation at the database's time. */
export type SenderPolicyReadContext = {
  db: SupabaseClient;
  nowMs: number;
  validUntilMs: number;
  workspaceId: string;
};

/** Keep a proof on the same side of every time-dependent policy boundary. */
export function recordSenderPolicyTransition(context: SenderPolicyReadContext | undefined, instant: string | number | null | undefined): void {
  if (!context || instant === null || instant === undefined) return;
  const ms = typeof instant === "number" ? instant : Date.parse(instant);
  if (!Number.isFinite(ms)) throw new Error("Sender policy validity could not be established.");
  if (ms > context.nowMs) context.validUntilMs = Math.min(context.validUntilMs, ms);
}
