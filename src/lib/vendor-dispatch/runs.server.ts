import "server-only";

import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordDispatchEvent } from "@/lib/vendor-dispatch/audit.server";
import {
  BROADCAST_ALL_CAP,
  advanceRun,
  canActorApprove,
  loadAttempts,
  loadHouse,
  loadRun,
  loadVendorContacts,
  requestApproval,
} from "@/lib/vendor-dispatch/engine.server";
import { isMissingRelationError, loadTradeRoster, matchDispatchRule } from "@/lib/vendor-dispatch/match.server";
import { sendVendorDispatchText } from "@/lib/vendor-dispatch/send.server";
import { composeVendorOfferText, stripContactDetails, toGsm7, type DispatchJobDetails } from "@/lib/vendor-dispatch/text";
import {
  DEFAULT_OFFER_TIMEOUT_MINUTES,
  NEVER_AUTO_DISPATCH_ISSUES,
  issueDefinition,
  tradeDefinition,
  type DispatchUrgency,
} from "@/lib/vendor-dispatch/trades";
import type { DispatchRunRow, DispatchSourceType } from "@/lib/vendor-dispatch/types";

/**
 * Dispatch-run actions (vendor-dispatch-1018). One run = one job offered down a rule's
 * vendor chain after the manager approves. The portal UI and the manager's SMS replies
 * both call these; the server re-derives the workspace and owner from the run, never
 * from the caller, and checks the acting person may approve for THAT workspace.
 */

export type DispatchRunActor = {
  /** Workspace owner the caller acts for (re-derived from the session by the route). */
  ownerUserId: string;
  /** The person approving: the owner or a teammate with Services access. */
  actorUserId: string;
  channel: "sms" | "portal";
};

export type DispatchRunActionResult =
  | { ok: true; status: string }
  | { ok: false; reason: "not_found" | "not_allowed" | "wrong_state" | "no_vendors" | "unavailable" };

export type CreateDispatchRunInput = {
  workspaceId: string;
  ownerUserId: string;
  sourceType: DispatchSourceType;
  sourceId: string;
  trade: string;
  issue?: string | null;
  urgency: DispatchUrgency;
  propertyId?: string | null;
  details: DispatchJobDetails;
  payCents?: number | null;
  createdBy?: string | null;
  /** The resident to update and ask "Is it fixed?" (work orders). Never shown to a vendor. */
  residentEmail?: string | null;
  workOrder?: import("@/data/demo-portal").DemoManagerWorkOrderRow | null;
  at?: Date;
  /** The caller is itself the manager's approval (a confirmed assistant write): do not text them to approve. */
  skipApprovalRequest?: boolean;
  /**
   * An explicit, new request from the manager (the assistant's dispatch_vendor): an
   * `exhausted` run for this job is finished business, so start a fresh run instead of
   * handing the old one back. Automatic triggers leave this off and stay idempotent.
   */
  restartExhausted?: boolean;
};

export type CreateDispatchRunResult =
  | { ok: true; created: boolean; run: DispatchRunRow }
  | { ok: false; reason: "bad_trade" | "never_auto" | "no_vendors" | "unavailable"; ruleId?: string | null };

const OPEN_FOR_SOURCE = ["awaiting_approval", "offering", "exhausted", "accepted"];

async function findRunForSource(
  db: SupabaseClient,
  sourceType: string,
  sourceId: string,
  opts: { skipExhausted?: boolean } = {},
): Promise<DispatchRunRow | null> {
  const { data, error } = await db
    .from("vendor_dispatch_runs")
    .select("*")
    .eq("source_type", sourceType)
    .eq("source_id", sourceId);
  if (error) {
    if (isMissingRelationError(error)) return null;
    throw new Error(error.message);
  }
  const rows = ((data ?? []) as DispatchRunRow[])
    .filter((row) => OPEN_FOR_SOURCE.includes(row.status) && !(opts.skipExhausted && row.status === "exhausted"))
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  return rows[0] ?? null;
}

/**
 * File a dispatch run for a job and ask the manager to approve it. Nothing reaches a
 * vendor before that approval. Idempotent on (source_type, source_id): a second call
 * for a job that already has a live run returns that run.
 */
export async function createDispatchRun(db: SupabaseClient, input: CreateDispatchRunInput): Promise<CreateDispatchRunResult> {
  const trade = tradeDefinition(input.trade);
  if (!trade) return { ok: false, reason: "bad_trade" };
  const issue = input.issue?.trim() || null;
  if (issue && NEVER_AUTO_DISPATCH_ISSUES.has(issue)) return { ok: false, reason: "never_auto" };
  const sourceId = input.sourceId.trim();
  if (!sourceId || !input.workspaceId || !input.ownerUserId) return { ok: false, reason: "unavailable" };

  const existing = await findRunForSource(db, input.sourceType, sourceId, { skipExhausted: input.restartExhausted === true });
  if (existing) {
    if (existing.owner_user_id !== input.ownerUserId) return { ok: false, reason: "unavailable" };
    return { ok: true, created: false, run: existing };
  }

  const at = input.at ?? new Date();
  const match = await matchDispatchRule(db, {
    workspaceId: input.workspaceId,
    ownerUserId: input.ownerUserId,
    trade: input.trade,
    issue,
    propertyId: input.propertyId ?? null,
    urgency: input.urgency,
    at,
    workOrder: input.workOrder ?? null,
  });
  if (match.chain.length === 0) return { ok: false, reason: "no_vendors", ruleId: match.rule?.id ?? null };
  const rule = match.rule;

  const house = await loadHouse(db, input.ownerUserId, input.propertyId ?? null).catch(() => null);
  const issueDef = issueDefinition(input.trade, issue);
  const details: DispatchJobDetails & Record<string, unknown> = {
    ...input.details,
    what: input.details.what || issueDef?.label || trade.label,
    houseLabel: input.details.houseLabel || house?.label || "",
    address: input.details.address || house?.address || "",
    area: input.details.area || house?.area || "",
    summary: input.details.summary ? stripContactDetails(input.details.summary).slice(0, 300) : undefined,
    payModel: rule?.pay_model ?? trade.defaultPayModel,
    broadcastSize: rule?.broadcast_size ?? 3,
    ruleName: rule?.name ?? null,
    chainSource: match.source,
  };
  const mode = rule?.mode ?? "sequential";
  const payCents = input.payCents ?? rule?.pay_cents ?? null;
  const timeoutMinutes = rule?.timeout_minutes ?? DEFAULT_OFFER_TIMEOUT_MINUTES[input.urgency];

  const handleResult = await db.rpc("next_vendor_dispatch_handle", { p_owner: input.ownerUserId });
  const handle = Number(handleResult.data);
  if (handleResult.error || !Number.isInteger(handle) || handle < 1) return { ok: false, reason: "unavailable" };

  const offerText = composeVendorOfferText({
    handle,
    details,
    payCents,
    payModel: String(details.payModel),
    deadlineLabel: details.deadlineLabel ?? null,
  });
  const nowIso = at.toISOString();
  const runId = randomUUID();
  const { error: insertError } = await db.from("vendor_dispatch_runs").insert({
    id: runId,
    workspace_id: input.workspaceId,
    owner_user_id: input.ownerUserId,
    handle,
    source_type: input.sourceType,
    source_id: sourceId,
    rule_id: rule?.id ?? null,
    trade: input.trade,
    issue,
    urgency: input.urgency,
    property_id: input.propertyId ?? null,
    offer_text: offerText,
    pay_cents: payCents,
    nte_cents: rule?.nte_cents ?? null,
    mode,
    timeout_minutes: timeoutMinutes,
    status: "awaiting_approval",
    created_by: input.createdBy ?? null,
    details,
    resident_email: input.residentEmail?.trim().toLowerCase() || null,
    deadline_at: input.details.deadlineIso ?? null,
    created_at: nowIso,
    updated_at: nowIso,
  });
  if (insertError) {
    if (insertError.code === "23505") {
      const raced = await findRunForSource(db, input.sourceType, sourceId, { skipExhausted: input.restartExhausted === true });
      if (raced && raced.owner_user_id === input.ownerUserId) return { ok: true, created: false, run: raced };
    }
    return { ok: false, reason: "unavailable" };
  }
  const { error: attemptError } = await db.from("vendor_dispatch_attempts").insert(
    match.chain.map((vendor, index) => ({
      id: randomUUID(),
      run_id: runId,
      vendor_directory_id: vendor.vendorDirectoryId,
      position: index,
      wave: 0,
      status: "queued",
      created_at: nowIso,
    })),
  );
  if (attemptError) {
    await db.from("vendor_dispatch_runs").update({ status: "canceled", updated_at: nowIso }).eq("id", runId);
    return { ok: false, reason: "unavailable" };
  }

  const run = (await loadRun(db, runId)) as DispatchRunRow;
  await recordDispatchEvent(db, {
    ownerUserId: input.ownerUserId,
    runId,
    handle,
    event: "created",
    actorUserId: input.createdBy ?? null,
    detail: { sourceType: input.sourceType, trade: input.trade, issue, urgency: input.urgency, vendors: match.chain.length, ruleId: rule?.id ?? null },
    now: at,
  });
  if (!input.skipApprovalRequest) {
    await requestApproval(db, run, "first").catch((error: unknown) =>
      console.error("vendor dispatch approval request failed", error instanceof Error ? error.message : "unknown"),
    );
  }
  return { ok: true, created: true, run: (await loadRun(db, runId)) ?? run };
}

async function authorize(
  db: SupabaseClient,
  input: DispatchRunActor & { runId: string },
): Promise<{ ok: true; run: DispatchRunRow } | { ok: false; reason: "not_found" | "not_allowed" }> {
  const run = await loadRun(db, input.runId);
  if (!run || run.owner_user_id !== input.ownerUserId) return { ok: false, reason: "not_found" };
  if (!(await canActorApprove(db, run, input.actorUserId))) return { ok: false, reason: "not_allowed" };
  return { ok: true, run };
}

/**
 * Approve the run's chain, or (`pickPosition`, the attempt's 0-based chain position) send
 * only the vendor at that position. The status flip is one conditional UPDATE, so a double
 * tap or an SMS and a portal click at once approve it exactly once.
 */
export async function approveDispatchRun(
  db: SupabaseClient,
  input: DispatchRunActor & { runId: string; pickPosition?: number | null; rawText?: string | null; now?: Date },
): Promise<DispatchRunActionResult> {
  const now = input.now ?? new Date();
  const auth = await authorize(db, input);
  if (!auth.ok) return auth;
  const { run } = auth;
  if (run.status !== "awaiting_approval") return { ok: false, reason: "wrong_state" };

  const attempts = await loadAttempts(db, run.id);
  const queued = attempts.filter((attempt) => attempt.status === "queued");
  if (queued.length === 0) return { ok: false, reason: "no_vendors" };
  const pick = input.pickPosition ?? null;
  if (pick != null && !queued.some((attempt) => attempt.position === pick)) return { ok: false, reason: "no_vendors" };

  const nowIso = now.toISOString();
  const { data: claimed } = await db
    .from("vendor_dispatch_runs")
    .update({
      status: "offering",
      approved_by: input.actorUserId,
      approved_at: nowIso,
      approval_channel: input.channel,
      updated_at: nowIso,
    })
    .eq("id", run.id)
    .eq("owner_user_id", run.owner_user_id)
    .eq("status", "awaiting_approval")
    .select("id");
  if (!claimed || (claimed as unknown[]).length === 0) return { ok: false, reason: "wrong_state" };

  if (pick != null) {
    for (const attempt of queued) {
      if (attempt.position !== pick) {
        await db.from("vendor_dispatch_attempts").update({ status: "canceled", response_text: "not picked" }).eq("id", attempt.id).eq("status", "queued");
      }
    }
  }
  await recordDispatchEvent(db, {
    ownerUserId: run.owner_user_id,
    runId: run.id,
    handle: run.handle,
    event: pick != null ? "approved_pick" : "approved",
    actorUserId: input.actorUserId,
    channel: input.channel,
    reply: input.rawText ?? null,
    detail: pick != null ? { pickPosition: pick } : undefined,
    now,
  });
  const advanced = await advanceRun(db, run.id, now);
  return { ok: true, status: advanced.status };
}

export async function declineDispatchRun(
  db: SupabaseClient,
  input: DispatchRunActor & { runId: string; rawText?: string | null; now?: Date },
): Promise<DispatchRunActionResult> {
  const now = input.now ?? new Date();
  const auth = await authorize(db, input);
  if (!auth.ok) return auth;
  const { run } = auth;
  if (run.status !== "awaiting_approval") return { ok: false, reason: "wrong_state" };
  const nowIso = now.toISOString();
  const { data: claimed } = await db
    .from("vendor_dispatch_runs")
    .update({ status: "declined_by_manager", updated_at: nowIso })
    .eq("id", run.id)
    .eq("owner_user_id", run.owner_user_id)
    .eq("status", "awaiting_approval")
    .select("id");
  if (!claimed || (claimed as unknown[]).length === 0) return { ok: false, reason: "wrong_state" };
  await db.from("vendor_dispatch_attempts").update({ status: "canceled", response_text: "declined by manager" }).eq("run_id", run.id).eq("status", "queued");
  await recordDispatchEvent(db, {
    ownerUserId: run.owner_user_id,
    runId: run.id,
    handle: run.handle,
    event: "declined_by_manager",
    actorUserId: input.actorUserId,
    channel: input.channel,
    reply: input.rawText ?? null,
    now,
  });
  return { ok: true, status: "declined_by_manager" };
}

/**
 * After an exhausted chain: offer it again to the same vendors, or (`broadcast`) to every
 * reachable vendor of the trade at once (up to ten). Re-asking resets the vendors' attempts
 * to queued under a new wave; the ones still on BUSY are skipped by the roster read.
 */
export async function retryDispatchRun(
  db: SupabaseClient,
  input: DispatchRunActor & { runId: string; broadcast: boolean; rawText?: string | null; now?: Date },
): Promise<DispatchRunActionResult> {
  const now = input.now ?? new Date();
  const auth = await authorize(db, input);
  if (!auth.ok) return auth;
  const { run } = auth;
  if (run.status !== "exhausted") return { ok: false, reason: "wrong_state" };
  const nowIso = now.toISOString();
  const attempts = await loadAttempts(db, run.id);

  let vendorIds: string[];
  if (input.broadcast) {
    const roster = await loadTradeRoster(db, { ownerUserId: run.owner_user_id, trade: run.trade, propertyId: run.property_id, at: now });
    vendorIds = roster.slice(0, BROADCAST_ALL_CAP).map((vendor) => vendor.vendorDirectoryId);
  } else {
    vendorIds = attempts.filter((attempt) => attempt.status !== "accepted").map((attempt) => attempt.vendor_directory_id);
    const contacts = await loadVendorContacts(db, run.owner_user_id, vendorIds);
    vendorIds = vendorIds.filter((id) => contacts.get(id)?.phone);
  }
  if (vendorIds.length === 0) return { ok: false, reason: "no_vendors" };

  const wave = (run.wave ?? 0) + 1;
  const { data: claimed } = await db
    .from("vendor_dispatch_runs")
    .update({
      status: "offering",
      wave,
      exhausted_at: null,
      ...(input.broadcast ? { mode: "broadcast", details: { ...run.details, broadcastSize: Math.max(2, Math.min(BROADCAST_ALL_CAP, vendorIds.length)) } } : {}),
      updated_at: nowIso,
    })
    .eq("id", run.id)
    .eq("owner_user_id", run.owner_user_id)
    .eq("status", "exhausted")
    .select("id");
  if (!claimed || (claimed as unknown[]).length === 0) return { ok: false, reason: "wrong_state" };

  let position = 0;
  const existingByVendor = new Map(attempts.map((attempt) => [attempt.vendor_directory_id, attempt] as const));
  for (const vendorId of vendorIds) {
    const prior = existingByVendor.get(vendorId);
    if (prior) {
      await db
        .from("vendor_dispatch_attempts")
        .update({
          status: "queued",
          wave,
          position,
          offered_at: null,
          timeout_at: null,
          responded_at: null,
          response_text: null,
          busy_until: null,
          proposed_time: null,
          quote_cents: null,
          quote_status: null,
        })
        .eq("id", prior.id);
    } else {
      await db.from("vendor_dispatch_attempts").insert({
        id: randomUUID(),
        run_id: run.id,
        vendor_directory_id: vendorId,
        position,
        wave,
        status: "queued",
        created_at: nowIso,
      });
    }
    position += 1;
  }
  await recordDispatchEvent(db, {
    ownerUserId: run.owner_user_id,
    runId: run.id,
    handle: run.handle,
    event: "retried",
    actorUserId: input.actorUserId,
    channel: input.channel,
    key: String(wave),
    reply: input.rawText ?? null,
    detail: { broadcast: input.broadcast, vendors: vendorIds.length },
    now,
  });
  const advanced = await advanceRun(db, run.id, now);
  return { ok: true, status: advanced.status };
}

/** Stop a run that has not been taken. Vendors with a live offer are told it is canceled. */
export async function cancelDispatchRun(
  db: SupabaseClient,
  input: DispatchRunActor & { runId: string; rawText?: string | null; now?: Date },
): Promise<DispatchRunActionResult> {
  const now = input.now ?? new Date();
  const auth = await authorize(db, input);
  if (!auth.ok) return auth;
  const { run } = auth;
  if (!["awaiting_approval", "offering", "exhausted"].includes(run.status)) return { ok: false, reason: "wrong_state" };
  const nowIso = now.toISOString();
  const { data: claimed } = await db
    .from("vendor_dispatch_runs")
    .update({ status: "canceled", updated_at: nowIso })
    .eq("id", run.id)
    .eq("owner_user_id", run.owner_user_id)
    .in("status", ["awaiting_approval", "offering", "exhausted"])
    .select("id");
  if (!claimed || (claimed as unknown[]).length === 0) return { ok: false, reason: "wrong_state" };

  const attempts = await loadAttempts(db, run.id);
  const contacts = await loadVendorContacts(db, run.owner_user_id, attempts.map((attempt) => attempt.vendor_directory_id));
  for (const attempt of attempts) {
    if (attempt.status === "queued") {
      await db.from("vendor_dispatch_attempts").update({ status: "canceled" }).eq("id", attempt.id).eq("status", "queued");
    } else if (attempt.status === "offered") {
      await db.from("vendor_dispatch_attempts").update({ status: "canceled", timeout_at: null }).eq("id", attempt.id).eq("status", "offered");
      const contact = contacts.get(attempt.vendor_directory_id);
      if (contact?.phone) {
        await sendVendorDispatchText(db, {
          ownerUserId: run.owner_user_id,
          workspaceId: run.workspace_id,
          vendorDirectoryId: contact.id,
          phone: contact.phone,
          vendorUserId: contact.vendorUserId,
          text: toGsm7(`Job #${run.handle} was canceled. Thanks`),
          idempotencyKey: `dispatch-cancel-${attempt.id}`,
        }).catch(() => undefined);
      }
    }
  }
  if (run.source_type === "work_order") {
    await db
      .from("work_order_vendor_offers")
      .update({ status: "withdrawn", updated_at: nowIso })
      .eq("work_order_id", run.source_id)
      .eq("manager_user_id", run.owner_user_id)
      .eq("status", "sent")
      .then(undefined, () => undefined);
  }
  await recordDispatchEvent(db, {
    ownerUserId: run.owner_user_id,
    runId: run.id,
    handle: run.handle,
    event: "canceled",
    actorUserId: input.actorUserId,
    channel: input.channel,
    reply: input.rawText ?? null,
    now,
  });
  return { ok: true, status: "canceled" };
}
