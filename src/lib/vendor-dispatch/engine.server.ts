import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeE164 } from "@/lib/phone-e164";
import {
  memberReceivesNotice,
} from "@/lib/workspace-team-recipients.server";
import { resolveWorkspaceTeamMembersWithGrants } from "@/lib/team-comms.server";
import { workOrderGeneralArea } from "@/lib/work-order-vendor-privacy";
import { recordDispatchEvent } from "@/lib/vendor-dispatch/audit.server";
import { isMissingRelationError } from "@/lib/vendor-dispatch/match.server";
import { serviceOwnerForWorkspace } from "@/lib/vendor-dispatch/service-roster.server";
import { sendTeamMemberDispatchText, sendVendorDispatchText } from "@/lib/vendor-dispatch/send.server";
import {
  composeApprovalText,
  composeExhaustedText,
  firstNameOf,
} from "@/lib/vendor-dispatch/text";
import { tradeDefinition } from "@/lib/vendor-dispatch/trades";
import type { DispatchAttemptRow, DispatchRunRow } from "@/lib/vendor-dispatch/types";

/**
 * The core of the dispatch loop: load, who approves, who is offered next, and the
 * advance step shared by the manager's approval, a vendor's decline or timeout, and
 * the sweep (vendor-dispatch-1018). Every transition is a conditional UPDATE keyed
 * on the status it expects, so two callers racing (two YES at once, an approval and
 * a sweep) leave exactly one winner.
 */

export const BROADCAST_ALL_CAP = 10;

export async function loadRun(db: SupabaseClient, runId: string): Promise<DispatchRunRow | null> {
  const { data, error } = await db.from("vendor_dispatch_runs").select("*").eq("id", runId).maybeSingle();
  if (error) {
    if (isMissingRelationError(error)) return null;
    throw new Error(error.message);
  }
  return (data as DispatchRunRow | null) ?? null;
}

export async function loadRunByHandle(
  db: SupabaseClient,
  ownerUserId: string,
  handle: number,
): Promise<DispatchRunRow | null> {
  const { data, error } = await db
    .from("vendor_dispatch_runs")
    .select("*")
    .eq("owner_user_id", ownerUserId)
    .eq("handle", handle)
    .maybeSingle();
  if (error) {
    if (isMissingRelationError(error)) return null;
    throw new Error(error.message);
  }
  return (data as DispatchRunRow | null) ?? null;
}

export async function loadAttempts(db: SupabaseClient, runId: string): Promise<DispatchAttemptRow[]> {
  const { data, error } = await db.from("vendor_dispatch_attempts").select("*").eq("run_id", runId);
  if (error) {
    if (isMissingRelationError(error)) return [];
    throw new Error(error.message);
  }
  return ((data ?? []) as DispatchAttemptRow[]).sort((a, b) => a.position - b.position);
}

export type VendorContact = {
  id: string;
  name: string;
  firstName: string;
  phone: string | null;
  vendorUserId: string | null;
};

/** Re-read roster rows at send time: a vendor removed or deactivated since the run was made is not texted. */
export async function loadVendorContacts(
  db: SupabaseClient,
  ownerUserId: string,
  ids: string[],
): Promise<Map<string, VendorContact>> {
  const out = new Map<string, VendorContact>();
  if (ids.length === 0) return out;
  const { data, error } = await db
    .from("manager_vendor_records")
    .select("id, manager_user_id, vendor_user_id, row_data")
    .in("id", ids);
  if (error) throw new Error(error.message);
  // A PropLane Service roster vendor (owned by the service owner) is a contact of any service workspace's run.
  let serviceOwnerId: string | null | undefined;
  for (const row of (data ?? []) as Array<{
    id: string;
    manager_user_id: string | null;
    vendor_user_id: string | null;
    row_data: { name?: string; preferredName?: string; phone?: string; active?: boolean; sharedWithManagers?: boolean; vendorUserId?: string | null; serviceRoster?: boolean; rosterRemovedAt?: string } | null;
  }>) {
    const vendor = row.row_data;
    if (!vendor || vendor.active === false) continue;
    if (row.manager_user_id !== ownerUserId && vendor.sharedWithManagers !== true) {
      if (vendor.serviceRoster !== true || vendor.rosterRemovedAt) continue;
      if (serviceOwnerId === undefined) {
        serviceOwnerId = await import("@/lib/service/service-catalog.server").then((m) => m.readPlatformServiceOwnerId(db)).catch(() => null);
      }
      if (!serviceOwnerId || serviceOwnerId !== row.manager_user_id) continue;
    }
    const name = String(vendor.name ?? "").trim() || "Vendor";
    out.set(row.id, {
      id: row.id,
      name,
      firstName: firstNameOf(vendor.preferredName || name) || "Vendor",
      phone: normalizeE164(String(vendor.phone ?? "").trim()),
      vendorUserId: row.vendor_user_id ?? vendor.vendorUserId ?? null,
    });
  }
  return out;
}

export type HouseInfo = { label: string; address: string; area: string };

export async function loadHouse(db: SupabaseClient, ownerUserId: string, propertyId: string | null): Promise<HouseInfo | null> {
  if (!propertyId) return null;
  const { data } = await db
    .from("manager_property_records")
    .select("id, property_data, row_data")
    .eq("id", propertyId)
    .eq("manager_user_id", ownerUserId)
    .maybeSingle();
  if (!data) return null;
  const src = ((data as { property_data?: unknown; row_data?: unknown }).property_data ??
    (data as { row_data?: unknown }).row_data ??
    {}) as Record<string, unknown>;
  const text = (key: string) => (typeof src[key] === "string" ? String(src[key]).trim() : "");
  const address = text("address");
  const street = address.split(",")[0]?.trim() ?? "";
  const label = street || text("buildingName") || text("title") || text("name") || "the house";
  return { label, address, area: workOrderGeneralArea({ propertyAddress: address, propertyName: text("title") || text("name") || label }) };
}

/** Who may approve a run: the owner first, then each teammate holding Services on the house. A viewer never does. */
export async function resolveApprovers(
  db: SupabaseClient,
  run: Pick<DispatchRunRow, "owner_user_id" | "workspace_id" | "property_id">,
): Promise<string[]> {
  // A PropLane Service workspace is run by the service manager: the client who owns it is view only, so the service
  // owner is the ONLY approver - neither the client nor any of their teammates is asked (or allowed) to answer, and
  // nothing falls through to them when the service manager has no verified phone.
  const serviceOwnerId = await serviceOwnerForWorkspace(db, run.workspace_id);
  if (serviceOwnerId) return [serviceOwnerId];
  const members = await resolveWorkspaceTeamMembersWithGrants(db, {
    ownerManagerUserId: run.owner_user_id,
    workspaceId: run.workspace_id,
  });
  const ids = [run.owner_user_id];
  for (const member of members) {
    if (member.isOwner || member.userId === run.owner_user_id) continue;
    if (member.teamRole === "viewer") continue;
    if (!memberReceivesNotice(member, { module: "services", propertyId: run.property_id })) continue;
    ids.push(member.userId);
  }
  return ids;
}

export async function canActorApprove(
  db: SupabaseClient,
  run: Pick<DispatchRunRow, "owner_user_id" | "workspace_id" | "property_id">,
  actorUserId: string,
): Promise<boolean> {
  if (!actorUserId) return false;
  // On a service workspace the client who owns the run is NOT an approver, so the approver list is the only
  // answer; anywhere else the owner always is, without needing the team read. The service-owner lookup is
  // memoized per client, so resolving it here and again inside `resolveApprovers` is one read.
  try {
    if (!(await serviceOwnerForWorkspace(db, run.workspace_id)) && actorUserId === run.owner_user_id) return true;
  } catch {
    return false;
  }
  try {
    return (await resolveApprovers(db, run)).includes(actorUserId);
  } catch {
    return false;
  }
}

export type ApproverAudience = "first" | "notified" | "remaining" | "everyone";

/**
 * Text the people who can answer a run. `first` stops at the first approver whose phone
 * can be texted (the owner, else the next teammate); `notified` repeats to whoever was
 * already asked; `remaining` is the escalation to everyone not yet asked.
 */
export async function notifyApprovers(
  db: SupabaseClient,
  run: DispatchRunRow,
  input: { audience: ApproverAudience; text: string; key: string },
): Promise<string[]> {
  const approvers = await resolveApprovers(db, run);
  const asked = new Set(run.approval_notified_user_ids ?? []);
  let targets: string[];
  if (input.audience === "notified") targets = approvers.filter((id) => asked.has(id));
  else if (input.audience === "remaining") targets = approvers.filter((id) => !asked.has(id));
  else targets = approvers;
  if (input.audience === "notified" && targets.length === 0) targets = approvers.slice(0, 1);

  const reached: string[] = [];
  for (const userId of targets) {
    const sent = await sendTeamMemberDispatchText(db, {
      ownerUserId: run.owner_user_id,
      workspaceId: run.workspace_id,
      memberUserId: userId,
      propertyId: run.property_id,
      text: input.text,
      dedupeKey: `dispatch:${run.id}:${input.key}:${userId}`,
    }).catch(() => ({ ok: false as const, reason: "send_failed" }));
    if (sent.ok) {
      reached.push(userId);
      if (input.audience === "first") break;
    }
  }
  if (reached.length > 0 && (input.audience === "first" || input.audience === "remaining" || input.audience === "everyone")) {
    const merged = [...new Set([...(run.approval_notified_user_ids ?? []), ...reached])];
    await db.from("vendor_dispatch_runs").update({ approval_notified_user_ids: merged, updated_at: new Date().toISOString() }).eq("id", run.id);
    run.approval_notified_user_ids = merged;
  }
  return reached;
}

/** Text everyone who was asked to approve (the owner when nobody was): outcome notices. */
export async function notifyOutcome(db: SupabaseClient, run: DispatchRunRow, text: string, key: string): Promise<void> {
  const asked = run.approval_notified_user_ids ?? [];
  const targets = asked.length > 0 ? asked : [run.owner_user_id];
  for (const userId of targets) {
    await sendTeamMemberDispatchText(db, {
      ownerUserId: run.owner_user_id,
      workspaceId: run.workspace_id,
      memberUserId: userId,
      propertyId: run.property_id,
      text,
      dedupeKey: `dispatch:${run.id}:${key}:${userId}`,
    }).catch(() => undefined);
  }
}

export function vendorNamesForApproval(attempts: DispatchAttemptRow[], contacts: Map<string, VendorContact>): string[] {
  return attempts
    .filter((attempt) => attempt.status === "queued" || attempt.status === "offered")
    .sort((a, b) => a.position - b.position)
    .map((attempt) => contacts.get(attempt.vendor_directory_id)?.name)
    .filter((name): name is string => Boolean(name));
}

/** Send (or resend) the first approval request for a run. */
export async function requestApproval(db: SupabaseClient, run: DispatchRunRow, audience: ApproverAudience = "first"): Promise<string[]> {
  const attempts = await loadAttempts(db, run.id);
  const contacts = await loadVendorContacts(db, run.owner_user_id, attempts.map((a) => a.vendor_directory_id));
  const trade = tradeDefinition(run.trade);
  const vendorNames = vendorNamesForApproval(attempts, contacts);
  const { dispatchProposalId, withDispatchApprovalCode } = await import("@/lib/vendor-dispatch/approval-code.server");
  const text = await withDispatchApprovalCode(
    db,
    run,
    "dispatch_approval",
    composeApprovalText({
      handle: run.handle,
      what: String(run.details.what || trade?.label || "Job"),
      houseLabel: String(run.details.houseLabel || run.details.area || "the house"),
      room: run.details.room ?? null,
      vendorNames,
      payCents: run.pay_cents,
      payModel: run.details.payModel as string | undefined,
      mode: run.mode,
    }),
    dispatchProposalId({ kind: "dispatch_approval", wave: run.wave ?? 0 }),
    vendorNames,
  );
  const reached = await notifyApprovers(db, run, {
    audience,
    text,
    key: audience === "first" ? "approve" : `approve-${audience}`,
  });
  if (reached.length > 0) {
    await recordDispatchEvent(db, {
      ownerUserId: run.owner_user_id,
      runId: run.id,
      handle: run.handle,
      event: "approval_requested",
      channel: "sms",
      key: audience === "first" ? undefined : audience,
      detail: { recipients: reached.length },
    });
  }
  return reached;
}

/** Terminal attempt states: this vendor is no longer in play for the run. */
const SPENT_ATTEMPT = new Set(["declined", "busy", "timed_out", "superseded", "canceled"]);

function outstandingCount(attempts: DispatchAttemptRow[]): number {
  return attempts.filter((attempt) => attempt.status === "offered").length;
}

/**
 * Offer one queued attempt: claim it (queued -> offered), text the vendor the run's
 * offer text, and surface the offer in the vendor portal for work orders. A vendor who
 * cannot be texted is marked canceled and the caller moves on to the next.
 */
export async function offerAttempt(
  db: SupabaseClient,
  run: DispatchRunRow,
  attempt: DispatchAttemptRow,
  contact: VendorContact | undefined,
  now: Date,
): Promise<"offered" | "failed" | "skipped"> {
  const nowIso = now.toISOString();
  const timeoutAt = new Date(now.getTime() + run.timeout_minutes * 60_000).toISOString();
  const { data: claimed } = await db
    .from("vendor_dispatch_attempts")
    .update({ status: "offered", offered_at: nowIso, timeout_at: timeoutAt })
    .eq("id", attempt.id)
    .eq("status", "queued")
    .select("id");
  if (!claimed || (claimed as unknown[]).length === 0) return "skipped";

  const fail = async (reason: string) => {
    await db
      .from("vendor_dispatch_attempts")
      .update({ status: "canceled", response_text: `unreachable:${reason}`.slice(0, 200), timeout_at: null })
      .eq("id", attempt.id);
    return "failed" as const;
  };
  if (!contact || !contact.phone) return fail("no_contact");

  const sent = await sendVendorDispatchText(db, {
    ownerUserId: run.owner_user_id,
    workspaceId: run.workspace_id,
    vendorDirectoryId: attempt.vendor_directory_id,
    phone: contact.phone,
    vendorUserId: contact.vendorUserId,
    text: run.offer_text,
    // The wave is in the key: a retry re-offers the same attempt, and the transport dedupes on this key.
    idempotencyKey: `dispatch-offer-${attempt.id}-w${attempt.wave ?? 0}`,
  }).catch((error: unknown) => ({ ok: false as const, reason: error instanceof Error ? error.message : "send_failed" }));
  if (!sent.ok) return fail(sent.reason);

  if (sent.outboxId) {
    await db.from("vendor_dispatch_attempts").update({ outbox_id: sent.outboxId }).eq("id", attempt.id);
  }
  if (run.source_type === "work_order") {
    await db
      .from("work_order_vendor_offers")
      .upsert(
        {
          work_order_id: run.source_id,
          vendor_directory_id: attempt.vendor_directory_id,
          vendor_user_id: contact.vendorUserId,
          manager_user_id: run.owner_user_id,
          status: "sent",
          expires_at: timeoutAt,
          updated_at: nowIso,
        },
        { onConflict: "work_order_id,vendor_directory_id" },
      )
      .then(undefined, () => undefined);
  }
  await recordDispatchEvent(db, {
    ownerUserId: run.owner_user_id,
    runId: run.id,
    handle: run.handle,
    event: "offered",
    channel: "system",
    key: attempt.id,
    detail: { vendorDirectoryId: attempt.vendor_directory_id, position: attempt.position },
    now,
  });
  return "offered";
}

function broadcastSizeOf(run: DispatchRunRow): number {
  if (run.mode !== "broadcast") return 1;
  const size = Number((run.details as Record<string, unknown>).broadcastSize);
  return Number.isFinite(size) && size >= 2 ? Math.min(BROADCAST_ALL_CAP, Math.floor(size)) : 3;
}

/** The run ended with nobody taking it: say so once, with the three ways forward. */
export async function exhaustRun(db: SupabaseClient, run: DispatchRunRow, now: Date): Promise<boolean> {
  const { data: changed } = await db
    .from("vendor_dispatch_runs")
    .update({ status: "exhausted", exhausted_at: now.toISOString(), updated_at: now.toISOString() })
    .eq("id", run.id)
    .eq("status", "offering")
    .select("id");
  if (!changed || (changed as unknown[]).length === 0) return false;
  await recordDispatchEvent(db, {
    ownerUserId: run.owner_user_id,
    runId: run.id,
    handle: run.handle,
    event: "exhausted",
    key: String(run.wave ?? 0),
    now,
  });
  const trade = tradeDefinition(run.trade);
  // R and B re-text vendors, so the exhausted ask carries the PropLane line's code too.
  const { dispatchProposalId, withDispatchApprovalCode } = await import("@/lib/vendor-dispatch/approval-code.server");
  await notifyOutcome(
    db,
    run,
    await withDispatchApprovalCode(
      db,
      run,
      "dispatch_retry",
      composeExhaustedText({ handle: run.handle, tradeLabel: trade?.label ?? "vendor" }),
      dispatchProposalId({ kind: "dispatch_retry", wave: run.wave ?? 0 }),
    ),
    `exhausted-${run.wave ?? 0}`,
  );
  return true;
}

/**
 * Keep the right number of offers out (one for sequential, `broadcast_size` for
 * broadcast) and close the run as exhausted when nobody is left to ask. Safe to call
 * repeatedly; the claims make a second concurrent call a no-op for any vendor already
 * offered.
 */
export async function advanceRun(
  db: SupabaseClient,
  runId: string,
  now: Date = new Date(),
): Promise<{ status: string; offered: number }> {
  const run = await loadRun(db, runId);
  if (!run || run.status !== "offering") return { status: run?.status ?? "missing", offered: 0 };
  let attempts = await loadAttempts(db, runId);
  const contacts = await loadVendorContacts(db, run.owner_user_id, attempts.map((a) => a.vendor_directory_id));
  const capacity = broadcastSizeOf(run);
  let offered = 0;

  for (const attempt of attempts.filter((a) => a.status === "queued")) {
    if (outstandingCount(attempts) >= capacity) break;
    const result = await offerAttempt(db, run, attempt, contacts.get(attempt.vendor_directory_id), now);
    if (result === "offered") {
      offered += 1;
      attempts = await loadAttempts(db, runId);
    } else if (result === "failed") {
      attempts = await loadAttempts(db, runId);
    }
  }

  const live = attempts.filter((a) => a.status === "offered" || a.status === "queued");
  const holding = attempts.some((a) => a.status === "offered" && a.quote_status === "pending");
  if (live.length === 0 && !holding) {
    await exhaustRun(db, run, now);
    return { status: "exhausted", offered };
  }
  return { status: "offering", offered };
}

export function isSpentAttempt(status: string): boolean {
  return SPENT_ATTEMPT.has(status);
}
