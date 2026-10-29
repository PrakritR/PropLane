import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { houseGroupReady } from "@/lib/house-groups/ready.server";
import { postToHouseGroup } from "@/lib/house-groups/post.server";
import type { HouseSubject, LeaseSubject } from "./moments";
import { getAutomationPreset, type AutomationPresetId } from "./presets";
import { sendRentDueDayLinks } from "./rent-due-links.server";
import { sendResidentAutomationText } from "./send.server";
import {
  claimRun,
  finishRun,
  loadAutomationSettings,
  loadRun,
  releaseRun,
  resolveAutomation,
} from "./store.server";
import {
  GROUP_VIOLATION_MESSAGES,
  groupTextViolations,
  missingRequiredVariables,
  renderTemplate,
  type TemplateVars,
} from "./templates";
import { loadHouseDirectory, loadLeaseSubjects } from "./sources.server";

/**
 * Fire one preset for one moment. This is the single door: the sweep, the announce route and the
 * booking presets claude-2 registers all come through `fireAutomation`.
 *
 *   off     -> nothing, nothing recorded (flip it on and the moment can still fire).
 *   draft   -> the text is held (a draft in the resident's thread, or in the Settings list for a
 *              group) and the manager sends it with one tap.
 *   auto    -> sent now. A quiet-hours or budget refusal gives the moment back so a later tick
 *              retries; every other outcome is recorded against the idempotency key.
 *
 * The text is filled from data and checked, never written by a model: a group text that names a
 * resident, carries an amount or a secret is refused (recorded as skipped, with the reason).
 */

export type ResidentTarget = {
  kind: "resident";
  phoneKey: string;
  residentUserId: string | null;
  residentEmail: string | null;
};

export type GroupTarget = {
  kind: "group";
  house: HouseSubject;
  /** The house's residents: their first names are barred from the text; with no group they are the fallback audience. */
  roster: readonly LeaseSubject[];
  /** Announcements and house-wide service notices fall back to each resident when there is no group. */
  fallbackToResidents: boolean;
};

export type FireRequest = {
  workspaceId: string;
  ownerUserId: string;
  preset: AutomationPresetId;
  idempotencyKey: string;
  vars: TemplateVars;
  target: ResidentTarget | GroupTarget;
};

export type FireOutcome =
  | { status: "sent"; runId: string }
  | { status: "held"; runId: string }
  | { status: "off" }
  | { status: "duplicate" }
  | { status: "deferred"; reason: string }
  | { status: "skipped"; reason: string; runId?: string }
  | { status: "failed"; reason: string; runId?: string };

type DeliverResult =
  | { ok: true }
  | { ok: false; retry: boolean; reason: string };

async function insertThreadDraft(
  db: SupabaseClient,
  input: { workspaceId: string; ownerUserId: string; phoneKey: string; preset: AutomationPresetId; body: string; propertyId: string | null },
): Promise<string | null> {
  try {
    const { data, error } = await db
      .from("sms_ai_reply_drafts")
      .insert({
        workspace_id: input.workspaceId,
        owner_user_id: input.ownerUserId,
        phone_key: input.phoneKey,
        role: "resident",
        topic: `automation:${input.preset}`,
        mode: "draft",
        status: "pending",
        inbound_text: "",
        body: input.body.slice(0, 1600),
        property_id: input.propertyId,
      })
      .select("id")
      .maybeSingle();
    if (error || !data) return null;
    return String((data as Record<string, unknown>).id);
  } catch {
    return null;
  }
}

/** Send the finished text to its audience. Shared by the auto path and a manager's approval. */
async function deliver(
  db: SupabaseClient,
  input: { workspaceId: string; ownerUserId: string; preset: AutomationPresetId; key: string; body: string; target: ResidentTarget | GroupTarget },
): Promise<DeliverResult> {
  const { target } = input;
  if (target.kind === "resident") {
    return sendResidentAutomationText(db, {
      workspaceId: input.workspaceId,
      ownerUserId: input.ownerUserId,
      phoneKey: target.phoneKey,
      residentUserId: target.residentUserId,
      residentEmail: target.residentEmail,
      text: input.body,
      idempotencyKey: input.key,
    });
  }

  // The group rule, checked against who lives there NOW (not when the text was drafted).
  const violations = groupTextViolations(input.body, {
    residentFirstNames: target.roster.map((r) => r.firstName),
    houseInfo: target.house.houseInfo,
    roomSecrets: target.house.roomSecrets,
  });
  if (violations.length > 0) return { ok: false, retry: false, reason: `group_text:${violations[0]}` };

  const ready = await houseGroupReady(db, input.workspaceId, target.house.propertyId);
  if (ready) {
    const posted = await postToHouseGroup(db, {
      workspaceId: input.workspaceId,
      propertyId: target.house.propertyId,
      text: input.body,
      kind: input.preset,
      idempotencyKey: `automation:${input.key}`,
    });
    if (posted.ok) {
      await sendDueDayLinks(db, input, target);
      return { ok: true };
    }
    if (posted.reason === "quiet_hours" || posted.reason === "rate_limited") {
      return { ok: false, retry: true, reason: posted.reason };
    }
    if (posted.reason !== "no_group" && posted.reason !== "not_enabled") {
      return { ok: false, retry: false, reason: posted.reason };
    }
  }
  if (!target.fallbackToResidents) return { ok: false, retry: false, reason: "no_group" };

  // No group: tell each resident one on one. Same text, so still no name, amount or secret.
  let sent = 0;
  let retry = false;
  let lastReason = "no_recipients";
  for (const resident of target.roster) {
    if (!resident.phoneKey) continue;
    const result = await sendResidentAutomationText(db, {
      workspaceId: input.workspaceId,
      ownerUserId: input.ownerUserId,
      phoneKey: resident.phoneKey,
      residentUserId: resident.residentUserId,
      residentEmail: resident.residentEmail,
      text: input.body,
      idempotencyKey: `${input.key}:${resident.phoneKey}`,
    });
    if (result.ok) sent += 1;
    else {
      lastReason = result.reason;
      retry = retry || result.retry;
    }
  }
  if (sent > 0) {
    await sendDueDayLinks(db, input, target);
    return { ok: true };
  }
  return { ok: false, retry, reason: lastReason };
}

/**
 * The rent-due-today house text promises "check your texts for your pay link": once it is out, each resident
 * with rent due gets their own link. Best effort, never part of whether the house text counts as sent.
 */
async function sendDueDayLinks(
  db: SupabaseClient,
  input: { preset: AutomationPresetId; key: string },
  target: GroupTarget,
): Promise<void> {
  if (input.preset !== "rent_due_day") return;
  const todayKey = input.key.split(":").pop() ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(todayKey)) return;
  await sendRentDueDayLinks(db, { house: target.house, roster: target.roster, todayKey }).catch(() => undefined);
}

export async function fireAutomation(db: SupabaseClient, request: FireRequest): Promise<FireOutcome> {
  const preset = getAutomationPreset(request.preset);
  if (!preset) return { status: "skipped", reason: "unknown_preset" };
  const settings = await loadAutomationSettings(db, request.workspaceId);
  const resolved = resolveAutomation(preset, settings.get(preset.id));
  if (resolved.mode === "off") return { status: "off" };

  if (missingRequiredVariables(resolved.template, request.vars).some((name) => preset.required.includes(name))) {
    return { status: "skipped", reason: "missing_facts" };
  }
  const body = renderTemplate(resolved.template, request.vars);
  if (!body) return { status: "skipped", reason: "empty" };

  if (request.target.kind === "group") {
    // A group-only preset with no group is silent: no draft to approve, nothing recorded.
    if (!request.target.fallbackToResidents && !(await houseGroupReady(db, request.workspaceId, request.target.house.propertyId))) {
      return { status: "skipped", reason: "no_group" };
    }
    const violations = groupTextViolations(body, {
      residentFirstNames: request.target.roster.map((r) => r.firstName),
      houseInfo: request.target.house.houseInfo,
      roomSecrets: request.target.house.roomSecrets,
    });
    if (violations.length > 0) {
      const runId = await claimRun(db, {
        workspaceId: request.workspaceId,
        ownerUserId: request.ownerUserId,
        preset: preset.id,
        idempotencyKey: request.idempotencyKey,
        audience: "group",
        mode: resolved.mode === "draft" ? "draft" : "auto",
        propertyId: request.target.house.propertyId,
        body,
      });
      if (runId) await finishRun(db, runId, { status: "skipped", reason: `group_text:${violations[0]}` });
      return { status: "skipped", reason: `group_text:${violations[0]}`, ...(runId ? { runId } : {}) };
    }
  }

  const audience = request.target.kind === "group" ? "group" : "resident";
  const propertyId = request.target.kind === "group" ? request.target.house.propertyId : null;
  const phoneKey = request.target.kind === "resident" ? request.target.phoneKey : null;
  const runId = await claimRun(db, {
    workspaceId: request.workspaceId,
    ownerUserId: request.ownerUserId,
    preset: preset.id,
    idempotencyKey: request.idempotencyKey,
    audience,
    mode: resolved.mode === "draft" ? "draft" : "auto",
    propertyId,
    phoneKey,
    body,
  });
  if (!runId) return { status: "duplicate" };

  if (resolved.mode === "draft") {
    let draftId: string | null = null;
    if (request.target.kind === "resident") {
      draftId = await insertThreadDraft(db, {
        workspaceId: request.workspaceId,
        ownerUserId: request.ownerUserId,
        phoneKey: request.target.phoneKey,
        preset: preset.id,
        body,
        propertyId: null,
      });
    }
    await finishRun(db, runId, { status: "held", draftId, body });
    return { status: "held", runId };
  }

  const delivered = await deliver(db, {
    workspaceId: request.workspaceId,
    ownerUserId: request.ownerUserId,
    preset: preset.id,
    key: request.idempotencyKey,
    body,
    target: request.target,
  });
  if (delivered.ok) {
    await finishRun(db, runId, { status: "sent" });
    return { status: "sent", runId };
  }
  if (delivered.retry) {
    await releaseRun(db, runId);
    return { status: "deferred", reason: delivered.reason };
  }
  const skippedReasons = new Set(["no_group", "no_consent", "opted_out", "no_recipients"]);
  const status = skippedReasons.has(delivered.reason) ? "skipped" : "failed";
  await finishRun(db, runId, { status, reason: delivered.reason });
  return { status, reason: delivered.reason, runId };
}

/* ─────────────────────────────  the manager's one tap  ───────────────────────────── */

export type ApproveOutcome =
  | { ok: true }
  | { ok: false; reason: "not_found" | "not_held" | "no_group" | "retry_later" | "refused"; message: string };

async function targetForHeldRun(
  db: SupabaseClient,
  run: Record<string, unknown>,
  workspaceId: string,
): Promise<ResidentTarget | GroupTarget | null> {
  const ownerUserId = String(run.owner_user_id);
  if (run.audience === "resident") {
    const phoneKey = String(run.phone_key ?? "");
    if (!/^\d{10}$/.test(phoneKey)) return null;
    const leases = await loadLeaseSubjects(db, { onlyOwner: ownerUserId });
    const lease = leases.find((l) => l.workspaceId === workspaceId && l.phoneKey === phoneKey);
    return { kind: "resident", phoneKey, residentUserId: lease?.residentUserId ?? null, residentEmail: lease?.residentEmail ?? null };
  }
  const propertyId = String(run.property_id ?? "");
  const houses = await loadHouseDirectory(db, [propertyId]);
  const house = houses.get(propertyId);
  if (!house || house.workspaceId !== workspaceId || house.ownerUserId !== ownerUserId) return null;
  const roster = (await loadLeaseSubjects(db, { onlyOwner: ownerUserId, houses })).filter((l) => l.propertyId === propertyId);
  const preset = getAutomationPreset(String(run.preset));
  return { kind: "group", house, roster, fallbackToResidents: preset?.id === "announcement" || preset?.id === "maintenance_booked" };
}

/** Send a held draft. The workspace comes from the caller's session, never the run's own id alone. */
export async function approveHeldRun(
  db: SupabaseClient,
  input: { workspaceId: string; runId: string },
): Promise<ApproveOutcome> {
  const run = await loadRun(db, input.workspaceId, input.runId);
  if (!run) return { ok: false, reason: "not_found", message: "That draft is gone." };
  if (run.status !== "held") return { ok: false, reason: "not_held", message: "That draft was already handled." };
  const preset = getAutomationPreset(String(run.preset));
  if (!preset) return { ok: false, reason: "not_found", message: "That draft is gone." };

  // Claim the send so a double tap sends once.
  const { data: claimed } = await db
    .from("workspace_automation_runs")
    .update({ status: "sending" })
    .eq("id", input.runId)
    .eq("workspace_id", input.workspaceId)
    .eq("status", "held")
    .select("id")
    .maybeSingle();
  if (!claimed) return { ok: false, reason: "not_held", message: "That draft was already handled." };

  const target = await targetForHeldRun(db, run, input.workspaceId);
  if (!target) {
    await finishRun(db, input.runId, { status: "failed", reason: "target_gone" });
    return { ok: false, reason: "refused", message: "That house or resident is no longer here." };
  }
  const delivered = await deliver(db, {
    workspaceId: input.workspaceId,
    ownerUserId: String(run.owner_user_id),
    preset: preset.id,
    key: String(run.idempotency_key),
    body: String(run.body ?? ""),
    target,
  });
  if (delivered.ok) {
    await finishRun(db, input.runId, { status: "sent" });
    if (run.draft_id) await markDraft(db, String(run.draft_id), "sent");
    return { ok: true };
  }
  if (delivered.retry) {
    await db.from("workspace_automation_runs").update({ status: "held" }).eq("id", input.runId).eq("status", "sending");
    return { ok: false, reason: "retry_later", message: "Texts are paused right now. Try again later." };
  }
  if (delivered.reason === "no_group") {
    await db.from("workspace_automation_runs").update({ status: "held" }).eq("id", input.runId).eq("status", "sending");
    return { ok: false, reason: "no_group", message: "This house has no group chat yet." };
  }
  const message = delivered.reason.startsWith("group_text:")
    ? GROUP_VIOLATION_MESSAGES[delivered.reason.slice("group_text:".length) as keyof typeof GROUP_VIOLATION_MESSAGES] ?? "That text cannot go to a group."
    : "Could not send.";
  await finishRun(db, input.runId, { status: "failed", reason: delivered.reason });
  return { ok: false, reason: "refused", message };
}

async function markDraft(db: SupabaseClient, draftId: string, status: "sent" | "rejected"): Promise<void> {
  try {
    await db
      .from("sms_ai_reply_drafts")
      .update({ status, decided_at: new Date().toISOString() })
      .eq("id", draftId)
      .eq("status", "pending");
  } catch {
    /* the draft card is a convenience; the run is the record */
  }
}

export async function dismissHeldRun(
  db: SupabaseClient,
  input: { workspaceId: string; runId: string },
): Promise<boolean> {
  const run = await loadRun(db, input.workspaceId, input.runId);
  if (!run || run.status !== "held") return false;
  await finishRun(db, input.runId, { status: "dismissed" });
  if (run.draft_id) await markDraft(db, String(run.draft_id), "rejected");
  return true;
}

/**
 * A held 1:1 draft the manager already handled from the thread (Use draft, then Send, or Reject)
 * leaves its run 'held' until this runs: it follows the draft's own status.
 */
export async function reconcileHeldRuns(db: SupabaseClient): Promise<number> {
  try {
    const { data } = await db
      .from("workspace_automation_runs")
      .select("id, draft_id")
      .eq("status", "held")
      .not("draft_id", "is", null)
      .limit(200);
    let changed = 0;
    for (const run of (data ?? []) as Array<{ id: string; draft_id: string }>) {
      const { data: draft } = await db.from("sms_ai_reply_drafts").select("status").eq("id", run.draft_id).maybeSingle();
      const status = (draft as { status?: string } | null)?.status;
      if (!status || status === "pending") continue;
      await finishRun(db, run.id, { status: status === "rejected" ? "dismissed" : "sent" });
      changed += 1;
    }
    return changed;
  } catch {
    return 0;
  }
}
