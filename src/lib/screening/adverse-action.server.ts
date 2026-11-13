import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import type { DemoApplicantRow } from "@/data/demo-portal";
import { emitActionEvent } from "@/lib/action-events.server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { managerHasCoManagerPermissionForProperty } from "@/lib/auth/manager-lease-scope";
import { managerSender } from "@/lib/domain-action-events.server";
import { noticeChannelFor } from "@/lib/notice-channel";
import {
  ADVERSE_ACTION_NOTICE_VERSION,
  adverseActionAllowsDecline,
  adverseActionCanceledNotice,
  adverseActionFinalizeAvailability,
  adverseActionFinalDueAt,
  finalAdverseNotice,
  preAdverseNotice,
  type AdverseActionFacts,
  type AdverseActionKind,
  type AdverseActionStage,
  type AdverseActionStatus,
  type AdverseNotice,
} from "@/lib/screening/adverse-action";
import { writeAuditLog } from "@/lib/tools/audit";

type AdverseRow = {
  id: string;
  application_id: string;
  report_id: string;
  action_kind: AdverseActionKind;
  based_on_report: boolean;
  stage: AdverseActionStage;
  pre_adverse_sent_at: string | null;
  final_due_at: string | null;
  final_sent_at: string | null;
};

const ADVERSE_SELECT =
  "id, application_id, report_id, action_kind, based_on_report, stage, pre_adverse_sent_at, final_due_at, final_sent_at";

function factsFrom(row: AdverseRow): AdverseActionFacts {
  return {
    id: row.id,
    reportId: row.report_id,
    basedOnReport: row.based_on_report,
    stage: row.stage,
    kind: row.action_kind,
    preAdverseSentAt: row.pre_adverse_sent_at,
    finalDueAt: row.final_due_at,
    finalSentAt: row.final_sent_at,
  };
}

/** The newest adverse-action record for an application (the decision always concerns its current report). */
export async function loadLatestAdverseAction(
  db: SupabaseClient,
  applicationId: string,
): Promise<{ error: boolean; facts: AdverseActionFacts | null }> {
  const { data, error } = await db
    .from("application_adverse_actions")
    .select(ADVERSE_SELECT)
    .eq("application_id", applicationId)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) return { error: true, facts: null };
  const row = (data?.[0] as AdverseRow | undefined) ?? null;
  return { error: false, facts: row ? factsFrom(row) : null };
}

export type AdverseActionApplication = {
  applicationId: string;
  managerUserId: string;
  row: DemoApplicantRow;
  propertyId: string;
  applicantName: string;
};

export type AdverseActionAccess =
  | ({ ok: true } & AdverseActionApplication)
  | { ok: false; status: number; error: string };

/**
 * The application a manager is acting on, re-derived from storage: the owner, an admin, or a co-manager holding
 * `applications` at the level asked. An application id in a request is a name, never a grant.
 */
export async function loadAdverseActionApplication(
  db: SupabaseClient,
  user: { id: string },
  applicationId: string,
  level: "read" | "edit",
): Promise<AdverseActionAccess> {
  const { data: record, error } = await db
    .from("manager_application_records")
    .select("id, manager_user_id, property_id, assigned_property_id, row_data")
    .eq("id", applicationId)
    .maybeSingle();
  if (error) return { ok: false, status: 503, error: "Applications are unavailable." };
  const row = (record?.row_data as DemoApplicantRow | null) ?? null;
  if (!record || !row) return { ok: false, status: 404, error: "Application not found." };
  const managerUserId = String(record.manager_user_id ?? row.managerUserId ?? "").trim();
  if (!managerUserId) return { ok: false, status: 400, error: "Application has no assigned manager." };
  const propertyId = String(record.assigned_property_id ?? record.property_id ?? "").trim();
  if (managerUserId !== user.id && !(await isAdminUser(user.id))) {
    const ids = [String(record.property_id ?? "").trim(), String(record.assigned_property_id ?? "").trim()].filter(Boolean);
    let allowed = false;
    for (const id of ids) {
      if (await managerHasCoManagerPermissionForProperty(db, user.id, id, "applications", level)) {
        allowed = true;
        break;
      }
    }
    if (!allowed) return { ok: false, status: 403, error: "Forbidden." };
  }
  return {
    ok: true,
    applicationId: String(record.id),
    managerUserId,
    row,
    propertyId,
    applicantName: row.name?.trim() || row.application?.fullLegalName?.trim() || row.email?.trim() || "",
  };
}

export function adverseActionStatusFor(
  row: Pick<DemoApplicantRow, "backgroundCheck">,
  facts: AdverseActionFacts | null,
  now: Date = new Date(),
): AdverseActionStatus {
  const check = row.backgroundCheck;
  const required = check?.status === "complete" && Boolean(check.reportId);
  const current = facts && check && facts.reportId === check.reportId ? facts : null;
  return {
    required,
    stage: current?.stage ?? "none",
    basedOnReport: current ? current.basedOnReport : null,
    preAdverseSentAt: current?.preAdverseSentAt ?? null,
    finalDueAt: current?.finalDueAt ?? null,
    finalSentAt: current?.finalSentAt ?? null,
    declineAllowed: !required || adverseActionAllowsDecline(current, check?.reportId ?? ""),
    canFinalize: adverseActionFinalizeAvailability(current, now).ok,
  };
}

/**
 * The backstop on the application write: a transition to Declined for an application with a completed consumer report
 * is refused unless the manager answered "not based on the report" or the final adverse-action notice went out. The
 * decline screen asks first; this is what makes the question impossible to skip. A read that fails refuses.
 */
export async function adverseActionDeclineBlocker(
  db: SupabaseClient,
  stored: { id?: string | null; row_data?: DemoApplicantRow | null } | null,
  next: Pick<DemoApplicantRow, "bucket">,
): Promise<"no" | "blocked" | "unchecked"> {
  const storedRow = stored?.row_data ?? null;
  if (next.bucket !== "rejected" || storedRow?.bucket === "rejected") return "no";
  const check = storedRow?.backgroundCheck;
  if (!check || check.status !== "complete" || !check.reportId) return "no";
  const applicationId = String(stored?.id ?? storedRow?.id ?? "").trim();
  if (!applicationId) return "unchecked";
  const latest = await loadLatestAdverseAction(db, applicationId);
  if (latest.error) return "unchecked";
  return adverseActionAllowsDecline(latest.facts, check.reportId) ? "no" : "blocked";
}

export const ADVERSE_ACTION_BLOCKED_MESSAGE =
  "Answer whether this decision is based on the background check before declining.";

function auditActor(managerUserId: string, userId: string, db: SupabaseClient) {
  return { landlordId: managerUserId, userId, db };
}

async function sendNotice(
  db: SupabaseClient,
  input: {
    app: AdverseActionApplication;
    eventId: string;
    event: string;
    notice: AdverseNotice;
    managerLine: string;
  },
): Promise<{ ok: boolean }> {
  const sender = await managerSender(db, input.app.managerUserId);
  if (!sender.email) return { ok: false };
  const residentEmail = input.app.row.email?.trim().toLowerCase() || undefined;
  const residentUserId = input.app.row.residentUserId ?? undefined;
  if (!residentEmail && !residentUserId) return { ok: false };
  const result = await emitActionEvent(db, {
    eventId: input.eventId,
    domain: "application",
    event: input.event,
    managerUserId: input.app.managerUserId,
    entityId: input.app.applicationId,
    category: "applications",
    // A regulated notice: PropLane speaks for itself, so no workspace template, mute or draft-for-review rewrites or
    // holds it. The channel follows where the application was made (portal = email + inbox, never a text).
    systemNotice: true,
    channel: noticeChannelFor(input.app.row),
    senderUserId: sender.userId,
    senderEmail: sender.email,
    senderName: sender.name,
    payload: { propertyId: input.app.propertyId || null, regulated: "fcra_adverse_action" },
    recipients: [
      { audience: "resident", userId: residentUserId, email: residentEmail, rendered: input.notice },
      {
        audience: "manager",
        userId: input.app.managerUserId,
        rendered: { subject: "Adverse action notice sent", text: input.managerLine, smsText: input.managerLine },
      },
    ],
  });
  return { ok: result.delivered + result.submitted + result.deferred > 0 };
}

export type AdverseActionResult =
  | { ok: true; status: AdverseActionStatus }
  | { ok: false; status: number; error: string; code?: string; adverse?: AdverseActionStatus };

function reportLink(origin: string, applicationId: string): string {
  return `${origin.replace(/\/$/, "")}/api/screening/adverse-action/report?applicationId=${encodeURIComponent(applicationId)}`;
}

async function updateStage(db: SupabaseClient, id: string, patch: Record<string, unknown>): Promise<boolean> {
  const { error } = await db
    .from("application_adverse_actions")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", id);
  return !error;
}

/**
 * The manager's answer to "Is this decision based in whole or part on the background check?".
 * NO records the answer (the application may then be declined with the normal notice). YES sends the PRE-ADVERSE
 * notice, stores the five-business-day due date and leaves the application where it is.
 */
export async function decideAdverseAction(
  db: SupabaseClient,
  input: {
    user: { id: string };
    applicationId: string;
    basedOnReport: boolean;
    kind?: AdverseActionKind;
    origin: string;
  },
): Promise<AdverseActionResult> {
  const access = await loadAdverseActionApplication(db, input.user, input.applicationId, "edit");
  if (!access.ok) return access;
  const check = access.row.backgroundCheck;
  const now = new Date();
  const latest = await loadLatestAdverseAction(db, access.applicationId);
  if (latest.error) return { ok: false, status: 503, error: "Adverse-action state is unavailable." };
  const current = adverseActionStatusFor(access.row, latest.facts, now);
  if (!current.required || !check) {
    // No completed consumer report: nothing regulated to answer. The normal decline applies.
    return { ok: true, status: current };
  }
  if (current.stage === "pre_adverse_sent") {
    return { ok: false, status: 409, error: "A pre-adverse notice is already waiting.", code: "already_pending", adverse: current };
  }
  if (current.stage === "not_based" || current.stage === "finalized") return { ok: true, status: current };

  const kind: AdverseActionKind = input.kind === "condition" ? "condition" : "decline";
  const actor = auditActor(access.managerUserId, input.user.id, db);
  const base = {
    application_id: access.applicationId,
    manager_user_id: access.managerUserId,
    decided_by: input.user.id,
    resident_email: access.row.email?.trim().toLowerCase() || null,
    report_id: check.reportId,
    action_kind: kind,
    based_on_report: input.basedOnReport,
    notice_version: ADVERSE_ACTION_NOTICE_VERSION,
  };

  if (!input.basedOnReport) {
    const { data, error } = await db
      .from("application_adverse_actions")
      .insert({ ...base, stage: "not_based" satisfies AdverseActionStage })
      .select(ADVERSE_SELECT)
      .single();
    if (error || !data) return { ok: false, status: 500, error: "Could not record the decision." };
    await writeAuditLog(actor, {
      action: "adverse_action_not_based",
      toolName: "adverse_action",
      inputSummary: { applicationId: access.applicationId, reportId: check.reportId, kind },
      dedupeKey: `adverse_action:not_based:${String((data as AdverseRow).id)}`,
    });
    return { ok: true, status: adverseActionStatusFor(access.row, factsFrom(data as AdverseRow), now) };
  }

  // Based on the report: the pre-adverse notice, a copy of the report, the rights summary and the waiting period.
  const dueAt = adverseActionFinalDueAt(now).toISOString();
  const { data, error } = await db
    .from("application_adverse_actions")
    .insert({
      ...base,
      stage: "pre_adverse_sent" satisfies AdverseActionStage,
      pre_adverse_sent_at: now.toISOString(),
      final_due_at: dueAt,
    })
    .select(ADVERSE_SELECT)
    .single();
  if (error || !data) return { ok: false, status: 500, error: "Could not record the decision." };
  const record = data as AdverseRow;
  const sent = await sendNotice(db, {
    app: access,
    eventId: `${access.applicationId}:adverse_pre:${record.id}`,
    event: "application_pre_adverse_action",
    notice: preAdverseNotice({
      applicantName: access.applicantName,
      propertyLabel: access.row.property,
      kind,
      reportUrl: reportLink(input.origin, access.applicationId),
      finalDate: dueAt,
    }),
    managerLine: `A pre-adverse notice went to ${access.applicantName || "the applicant"}. The final notice can go out after ${dueAt.slice(0, 10)}.`,
  }).catch(() => ({ ok: false }));
  if (!sent.ok) {
    // Nothing reached the applicant: the answer stands for nobody. Withdraw the record so the manager can try again.
    await updateStage(db, record.id, { stage: "canceled", canceled_at: new Date().toISOString() });
    return { ok: false, status: 502, error: "The notice could not be sent. Nothing was recorded; try again.", code: "notice_failed" };
  }
  await writeAuditLog(actor, {
    action: "adverse_action_pre_adverse_sent",
    toolName: "adverse_action",
    inputSummary: { applicationId: access.applicationId, reportId: check.reportId, kind, finalDueAt: dueAt },
    dedupeKey: `adverse_action:pre:${record.id}`,
  });
  return { ok: true, status: adverseActionStatusFor(access.row, factsFrom(record), now) };
}

/** Send the FINAL adverse-action notice once the waiting period has passed. The caller then saves the decline. */
export async function finalizeAdverseAction(
  db: SupabaseClient,
  input: { user: { id: string }; applicationId: string; origin: string },
): Promise<AdverseActionResult> {
  const access = await loadAdverseActionApplication(db, input.user, input.applicationId, "edit");
  if (!access.ok) return access;
  const now = new Date();
  const latest = await loadLatestAdverseAction(db, access.applicationId);
  if (latest.error) return { ok: false, status: 503, error: "Adverse-action state is unavailable." };
  const status = adverseActionStatusFor(access.row, latest.facts, now);
  if (status.stage === "finalized") return { ok: true, status };
  const availability = adverseActionFinalizeAvailability(latest.facts && status.stage !== "none" ? latest.facts : null, now);
  if (!availability.ok) {
    return availability.reason === "waiting"
      ? { ok: false, status: 409, error: "The waiting period has not ended.", code: "waiting_period", adverse: status }
      : { ok: false, status: 409, error: "There is no pre-adverse notice to finalize.", code: "not_pre_adverse", adverse: status };
  }
  const facts = latest.facts!;
  const sent = await sendNotice(db, {
    app: access,
    eventId: `${access.applicationId}:adverse_final:${facts.id}`,
    event: "application_final_adverse_action",
    notice: finalAdverseNotice({
      applicantName: access.applicantName,
      propertyLabel: access.row.property,
      kind: facts.kind,
      reportUrl: reportLink(input.origin, access.applicationId),
    }),
    managerLine: `The final adverse-action notice went to ${access.applicantName || "the applicant"}.`,
  }).catch(() => ({ ok: false }));
  if (!sent.ok) return { ok: false, status: 502, error: "The final notice could not be sent. Try again.", code: "notice_failed" };
  if (!(await updateStage(db, facts.id, { stage: "finalized", final_sent_at: now.toISOString() }))) {
    return { ok: false, status: 500, error: "The notice was sent but could not be recorded. Refresh and retry.", code: "record_failed" };
  }
  await writeAuditLog(auditActor(access.managerUserId, input.user.id, db), {
    action: "adverse_action_final_sent",
    toolName: "adverse_action",
    inputSummary: { applicationId: access.applicationId, reportId: facts.reportId, kind: facts.kind },
    dedupeKey: `adverse_action:final:${facts.id}`,
  });
  return { ok: true, status: adverseActionStatusFor(access.row, { ...facts, stage: "finalized", finalSentAt: now.toISOString() }, now) };
}

/** Withdraw a pre-adverse notice during the waiting period. The applicant is told nothing adverse will follow from it. */
export async function cancelAdverseAction(
  db: SupabaseClient,
  input: { user: { id: string }; applicationId: string },
): Promise<AdverseActionResult> {
  const access = await loadAdverseActionApplication(db, input.user, input.applicationId, "edit");
  if (!access.ok) return access;
  const now = new Date();
  const latest = await loadLatestAdverseAction(db, access.applicationId);
  if (latest.error) return { ok: false, status: 503, error: "Adverse-action state is unavailable." };
  const facts = latest.facts;
  if (!facts || facts.stage !== "pre_adverse_sent") {
    return { ok: false, status: 409, error: "There is no pending pre-adverse notice.", code: "not_pre_adverse" };
  }
  if (!(await updateStage(db, facts.id, { stage: "canceled", canceled_at: now.toISOString() }))) {
    return { ok: false, status: 500, error: "Could not cancel the notice." };
  }
  await sendNotice(db, {
    app: access,
    eventId: `${access.applicationId}:adverse_cancel:${facts.id}`,
    event: "application_adverse_action_canceled",
    notice: adverseActionCanceledNotice({ applicantName: access.applicantName, propertyLabel: access.row.property }),
    managerLine: `You withdrew the pre-adverse notice for ${access.applicantName || "the applicant"}.`,
  }).catch(() => ({ ok: false }));
  await writeAuditLog(auditActor(access.managerUserId, input.user.id, db), {
    action: "adverse_action_canceled",
    toolName: "adverse_action",
    inputSummary: { applicationId: access.applicationId, reportId: facts.reportId },
    dedupeKey: `adverse_action:cancel:${facts.id}`,
  });
  return { ok: true, status: adverseActionStatusFor(access.row, { ...facts, stage: "canceled" }, now) };
}
