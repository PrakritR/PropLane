import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isMissingDispatchRelation } from "@/lib/vendor-dispatch/access.server";
import { asAttemptStatus, type VendorDispatchOffer } from "@/lib/vendor-dispatch/runs-view";
import { issueDefinition, tradeDefinition } from "@/lib/vendor-dispatch/trades";

/**
 * The vendor's side of dispatch in the vendor portal (vendor-dispatch-1018).
 *
 * A vendor sees their OWN offered attempts only: the vendor record is resolved
 * from `manager_vendor_records.vendor_user_id = auth.uid()`, never from the
 * request, and what is served is the run's `offer_text` (the general area, no
 * street address, no resident) plus trade, pay and deadline. Nothing here
 * returns a house id or a workspace id.
 */
export type { VendorDispatchOffer };

type AttemptRow = {
  id: string;
  run_id: string;
  vendor_directory_id: string;
  status: string;
  timeout_at: string | null;
};

async function ownVendorRecordIds(db: SupabaseClient, vendorUserId: string): Promise<string[]> {
  const { data, error } = await db.from("manager_vendor_records").select("id").eq("vendor_user_id", vendorUserId);
  if (error) throw error;
  return (data ?? []).map((row) => String(row.id));
}

export async function listVendorDispatchOffers(
  db: SupabaseClient,
  vendorUserId: string,
  now: Date = new Date(),
): Promise<{ ok: true; offers: VendorDispatchOffer[] } | { ok: false; error: string }> {
  let recordIds: string[];
  try {
    recordIds = await ownVendorRecordIds(db, vendorUserId);
  } catch {
    return { ok: false, error: "Could not load offers." };
  }
  if (recordIds.length === 0) return { ok: true, offers: [] };

  const { data: attempts, error } = await db
    .from("vendor_dispatch_attempts")
    .select("id, run_id, vendor_directory_id, status, timeout_at")
    .in("vendor_directory_id", recordIds)
    .in("status", ["offered", "accepted"])
    .order("offered_at", { ascending: false })
    .limit(100);
  if (error) {
    if (isMissingDispatchRelation(error)) return { ok: true, offers: [] };
    return { ok: false, error: "Could not load offers." };
  }
  const live = ((attempts ?? []) as AttemptRow[]).filter(
    (attempt) => attempt.status === "accepted" || !attempt.timeout_at || new Date(attempt.timeout_at) > now,
  );
  if (live.length === 0) return { ok: true, offers: [] };

  const { data: runs } = await db
    .from("vendor_dispatch_runs")
    .select("id, handle, trade, issue, urgency, offer_text, pay_cents, status, accepted_vendor_directory_id")
    .in("id", [...new Set(live.map((attempt) => attempt.run_id))]);
  const runById = new Map((runs ?? []).map((run) => [String(run.id), run]));

  const offers: VendorDispatchOffer[] = [];
  for (const attempt of live) {
    const run = runById.get(attempt.run_id);
    if (!run) continue;
    // An offer is live while the run is offering; an accepted one stays listed only for the vendor who took it.
    if (attempt.status === "offered" && run.status !== "offering") continue;
    if (attempt.status === "accepted" && run.accepted_vendor_directory_id !== attempt.vendor_directory_id) continue;
    offers.push({
      attemptId: attempt.id,
      handle: Number(run.handle),
      tradeLabel: tradeDefinition(String(run.trade))?.label ?? "Job",
      issueLabel: issueDefinition(String(run.trade), run.issue as string | null)?.label ?? null,
      urgency: String(run.urgency),
      offerText: String(run.offer_text ?? ""),
      payCents: (run.pay_cents as number | null) ?? null,
      status: asAttemptStatus(attempt.status),
      answerBy: attempt.status === "offered" ? attempt.timeout_at : null,
    });
  }
  return { ok: true, offers };
}

export type VendorAnswerResult =
  | { ok: true; status: "accepted" | "declined" }
  | { ok: false; reason: "not_found" | "expired" | "already_answered" | "unavailable" };

/**
 * A thin compare-and-set over the engine's tables. The SMS reply parser and
 * this route must land in the same state, so every transition is conditional
 * on the attempt still being `offered` (and the run still `offering`): the
 * second of two simultaneous answers loses with `already_answered`.
 * Choosing the NEXT vendor after a decline is the engine's job (its timeout
 * sweep offers the next queued attempt of an `offering` run).
 */
export async function answerVendorDispatchOffer(
  db: SupabaseClient,
  input: { vendorUserId: string; attemptId: string; answer: "accept" | "decline" },
  now: Date = new Date(),
): Promise<VendorAnswerResult> {
  if (!/^[0-9a-f-]{36}$/i.test(input.attemptId)) return { ok: false, reason: "not_found" };
  let recordIds: string[];
  try {
    recordIds = await ownVendorRecordIds(db, input.vendorUserId);
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  const { data: attempt, error } = await db
    .from("vendor_dispatch_attempts")
    .select("id, run_id, vendor_directory_id, status, timeout_at")
    .eq("id", input.attemptId)
    .maybeSingle();
  if (error) return { ok: false, reason: isMissingDispatchRelation(error) ? "not_found" : "unavailable" };
  // Someone else's attempt reads as gone, never as forbidden.
  if (!attempt || !recordIds.includes(String(attempt.vendor_directory_id))) return { ok: false, reason: "not_found" };
  if (attempt.status !== "offered") return { ok: false, reason: "already_answered" };
  if (attempt.timeout_at && new Date(attempt.timeout_at as string) <= now) return { ok: false, reason: "expired" };

  const stamp = now.toISOString();
  const answered = await db
    .from("vendor_dispatch_attempts")
    .update({
      status: input.answer === "accept" ? "accepted" : "declined",
      responded_at: stamp,
      response_text: input.answer === "accept" ? "Accepted in the vendor portal" : "Declined in the vendor portal",
    })
    .eq("id", attempt.id)
    .eq("status", "offered")
    .select("id")
    .maybeSingle();
  if (answered.error) return { ok: false, reason: "unavailable" };
  if (!answered.data) return { ok: false, reason: "already_answered" };
  if (input.answer === "decline") return { ok: true, status: "declined" };

  const claimed = await db
    .from("vendor_dispatch_runs")
    .update({
      status: "accepted",
      accepted_vendor_directory_id: attempt.vendor_directory_id,
      accepted_at: stamp,
      updated_at: stamp,
    })
    .eq("id", attempt.run_id)
    .eq("status", "offering")
    .select("id")
    .maybeSingle();
  if (claimed.error || !claimed.data) {
    // The job was taken, canceled or declined first: this answer does not stand.
    await db.from("vendor_dispatch_attempts").update({ status: "superseded" }).eq("id", attempt.id);
    return { ok: false, reason: claimed.error ? "unavailable" : "already_answered" };
  }
  await db
    .from("vendor_dispatch_attempts")
    .update({ status: "superseded" })
    .eq("run_id", attempt.run_id)
    .neq("id", attempt.id)
    .in("status", ["queued", "offered"]);
  return { ok: true, status: "accepted" };
}
