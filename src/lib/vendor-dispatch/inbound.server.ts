import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { readPortalAssistantSmsSession } from "@/lib/agent/portal-assistant-session.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { attachVendorJobMedia, linkVendorRunMedia } from "@/lib/one-number/inbound-media.server";
import { recordDispatchEvent } from "@/lib/vendor-dispatch/audit.server";
import { resolveOpenSmsProposal } from "@/lib/sms/agent-confirmation.server";
import { SMS_CONFIRMATION_CANCELLED_REPLY, SMS_CONFIRMATION_LOCKED_REPLY } from "@/lib/sms/confirmation-code";
import { decideRunInvoice, handleResidentFixedReply, recordVendorDone, recordVendorInvoice } from "@/lib/vendor-dispatch/completion.server";
import { canActorApprove, loadAttempts, loadVendorContacts, type VendorContact } from "@/lib/vendor-dispatch/engine.server";
import { isMissingRelationError } from "@/lib/vendor-dispatch/match.server";
import {
  parseManagerDispatchReply,
  parseResidentFixedReply,
  parseVendorDispatchReply,
  type ManagerDispatchReply,
  type VendorDispatchReply,
} from "@/lib/vendor-dispatch/reply-parse";
import {
  checkDispatchApprovalCode,
  clearDispatchApprovalCode,
  codedAnswerLine,
  dispatchApprovalVendorNames,
  reaskDispatchApprovalCode,
  type DispatchApprovalKind,
} from "@/lib/vendor-dispatch/approval-code.server";
import { approveDispatchRun, declineDispatchRun, retryDispatchRun } from "@/lib/vendor-dispatch/runs.server";
import { decideVendorQuote, recordVendorBusy, recordVendorNo, recordVendorYes } from "@/lib/vendor-dispatch/responses.server";
import { sendVendorDispatchText } from "@/lib/vendor-dispatch/send.server";
import { toGsm7 } from "@/lib/vendor-dispatch/text";
import { isDispatchKeyword } from "@/lib/vendor-dispatch/service-default.server";
import { maybeCreateRuleRunForWorkOrder } from "@/lib/vendor-dispatch/triggers.server";
import type { DispatchAttemptRow, DispatchRunRow } from "@/lib/vendor-dispatch/types";

/**
 * Deterministic handling of the replies the dispatch loop asks for, called from the
 * inbound SMS pipeline BEFORE any agent sees the text (vendor-dispatch-1018).
 * `handled: false` means "not ours": the normal router carries on, untouched.
 *
 * Scoping: the owner and workspace come from the work number the text arrived on
 * (the pipeline's verified identity), never from the body; a run of another owner or
 * workspace is invisible here, and a reply can only act on a run the sender may act on.
 */

export type InboundHandled = { handled: false } | { handled: true; reply?: string };

type PendingKind = "approval" | "quote" | "invoice" | "exhausted";
type PendingItem = { kind: PendingKind; run: DispatchRunRow };

/** A finished job stays answerable (an invoice) for this long. */
const COMPLETED_RUN_WINDOW_DAYS = 30;

async function loadOwnerRuns(
  db: SupabaseClient,
  ownerUserId: string | string[],
  workspaceId: string | string[] | null,
  statuses: string[],
  options: { completed?: "invoice_pending" | "recent" } = {},
): Promise<DispatchRunRow[]> {
  const owners = Array.isArray(ownerUserId) ? ownerUserId : [ownerUserId];
  const live = await db.from("vendor_dispatch_runs").select("*").in("owner_user_id", owners).in("status", statuses);
  if (live.error) {
    if (isMissingRelationError(live.error)) return [];
    throw new Error(live.error.message);
  }
  let rows = (live.data ?? []) as DispatchRunRow[];
  if (options.completed) {
    let query = db.from("vendor_dispatch_runs").select("*").in("owner_user_id", owners).eq("status", "completed");
    query =
      options.completed === "invoice_pending"
        ? query.not("pending_invoice_cents", "is", null)
        : query.gte("completed_at", new Date(Date.now() - COMPLETED_RUN_WINDOW_DAYS * 86_400_000).toISOString());
    const done = await query;
    if (done.error) throw new Error(done.error.message);
    rows = [...rows, ...((done.data ?? []) as DispatchRunRow[])];
  }
  const workspaces = Array.isArray(workspaceId) ? workspaceId : workspaceId ? [workspaceId] : null;
  return rows.filter((run) => !workspaces || workspaces.includes(run.workspace_id));
}

/**
 * Whose runs a text to this number can answer. A work number answers its own owner's runs. The PropLane line (the service
 * owner's number) also answers the runs of every PropLane Service workspace, because roster vendors are texted from it:
 * their YES arrives here, while the runs belong to the client who owns the workspace. Only `is_service` workspaces are
 * added, never the rest of a client's workspaces.
 */
async function replyScope(
  db: SupabaseClient,
  ownerUserId: string,
  workspaceId: string | null,
): Promise<{ owners: string[]; workspaces: string[] | string | null }> {
  try {
    const { readPlatformServiceOwnerId } = await import("@/lib/service/service-catalog.server");
    if ((await readPlatformServiceOwnerId(db)) !== ownerUserId) return { owners: [ownerUserId], workspaces: workspaceId };
    const { data, error } = await db.from("portal_workspaces").select("id, owner_user_id").eq("is_service", true).limit(500);
    if (error) return { owners: [ownerUserId], workspaces: workspaceId };
    const rows = (data ?? []) as Array<{ id: string; owner_user_id: string }>;
    return { owners: [...new Set([ownerUserId, ...rows.map((row) => row.owner_user_id)])], workspaces: rows.map((row) => row.id) };
  } catch {
    return { owners: [ownerUserId], workspaces: workspaceId };
  }
}

/** Everything awaiting THIS person's answer, newest first. */
export async function listPendingForActor(
  db: SupabaseClient,
  input: { ownerUserId: string; workspaceId: string | null; actorUserId: string },
): Promise<PendingItem[]> {
  const runs = await loadOwnerRuns(db, input.ownerUserId, input.workspaceId, ["awaiting_approval", "offering", "exhausted", "accepted"], {
    completed: "invoice_pending",
  });
  const items: PendingItem[] = [];
  for (const run of runs) {
    let kind: PendingKind | null = null;
    if (run.status === "awaiting_approval") kind = "approval";
    else if (run.status === "exhausted") kind = "exhausted";
    else if (run.pending_invoice_cents != null && (run.status === "accepted" || run.status === "completed")) kind = "invoice";
    else if (run.status === "offering") {
      const attempts = await loadAttempts(db, run.id);
      if (attempts.some((attempt) => attempt.status === "offered" && attempt.quote_status === "pending")) kind = "quote";
    }
    if (!kind) continue;
    if (!(await canActorApprove(db, run, input.actorUserId))) continue;
    items.push({ kind, run });
  }
  return items.sort((a, b) => b.run.handle - a.run.handle);
}

async function assistantProposalOpen(db: SupabaseClient, input: { actorUserId: string; workspaceId: string | null }): Promise<boolean> {
  try {
    const found = await readPortalAssistantSmsSession(db, { actorUserId: input.actorUserId, workspaceId: input.workspaceId });
    if (!found.ok || !found.session) return false;
    const open = await resolveOpenSmsProposal(db, { userId: input.actorUserId, sessionId: found.session.id, portal: "manager" });
    return open.status === "one" || open.status === "ambiguous";
  } catch {
    // Unreadable is not evidence of an open proposal, and a bare Y with a dispatch waiting is the dispatch's.
    return false;
  }
}

function describeFailure(reason: string, handle: number): string {
  if (reason === "not_allowed") return `You cannot answer #${handle}.`;
  if (reason === "not_found") return `No open job #${handle}.`;
  if (reason === "no_vendors") return `No one left to text for #${handle}.`;
  if (reason === "tier") return `Approving #${handle} needs the Pro plan. Open PropLane to continue.`;
  if (reason === "unavailable") return `Could not finish #${handle}. Try again or open PropLane.`;
  return `#${handle} is already handled.`;
}

/** Every pending answer on the PropLane line carries its code: each one either commits spend or texts vendors. */
const CODED_ANSWER_KIND: Record<PendingKind, DispatchApprovalKind> = {
  approval: "dispatch_approval",
  quote: "dispatch_quote",
  invoice: "dispatch_invoice",
  exhausted: "dispatch_retry",
};

const APPLICABLE: Record<ManagerDispatchReply["kind"], PendingKind[]> = {
  approve: ["approval", "quote", "invoice"],
  decline: ["approval", "quote", "invoice"],
  pick: ["approval"],
  retry: ["exhausted"],
  broadcast: ["exhausted"],
};

/** Repairs filed in the last week that nobody has been sent to, newest first (the DISPATCH reply's candidates). */
const DISPATCH_KEYWORD_WINDOW_DAYS = 7;

/** Does this repair belong to the workspace whose work number was texted? (Its house's workspace, else the owner's default.) */
async function repairIsInWorkspace(
  db: SupabaseClient,
  record: { id: string; row_data?: Record<string, unknown> | null },
  input: { ownerUserId: string; workspaceId: string | null },
): Promise<boolean> {
  if (!input.workspaceId) return true;
  const row = record.row_data ?? {};
  const propertyId = String(row.assignedPropertyId ?? row.propertyId ?? "").trim() || null;
  const { resolveOwnerAndWorkspace } = await import("@/lib/vendor-dispatch/triggers.server");
  const scope = await resolveOwnerAndWorkspace(db, { ownerUserId: input.ownerUserId, propertyId }).catch(() => null);
  return scope?.workspaceId === input.workspaceId;
}

/**
 * `DISPATCH`: the manager asked to text their vendors for the newest unassigned repair. It opens the same run a rule would,
 * with the workspace roster as the chain, and waits for their Y before anyone is texted. Scoped to the work number's owner and
 * workspace; the sender is the pipeline's verified manager.
 */
async function handleDispatchKeyword(
  db: SupabaseClient,
  input: { ownerUserId: string; workspaceId: string | null; actorUserId: string },
): Promise<InboundHandled> {
  const since = new Date(Date.now() - DISPATCH_KEYWORD_WINDOW_DAYS * 86_400_000).toISOString();
  const { data, error } = await db
    .from("portal_work_order_records")
    .select("id, row_data, updated_at")
    .eq("manager_user_id", input.ownerUserId)
    .gte("updated_at", since)
    .order("updated_at", { ascending: false })
    .limit(25);
  if (error) return { handled: false };
  const rows = ((data ?? []) as Array<{ id: string; row_data?: Record<string, unknown> | null }>).filter((record) => {
    const row = record.row_data ?? {};
    return row.bucket === "open" && !row.vendorId && row.selfAssigned !== true && row.managerInitiated !== true && Boolean(row.category);
  });
  if (rows.length === 0) return { handled: false };
  for (const record of rows) {
    // The repair must belong to the workspace whose number was texted. An owner of several workspaces texting
    // DISPATCH to one number could otherwise open a run against another workspace's repair, landing the work
    // (and its bill) on the wrong workspace's ledger and calendar.
    if (input.workspaceId && !(await repairIsInWorkspace(db, record, input))) continue;
    // The manager asked for this themselves, so a finished run for the repair (declined, canceled, completed) is
    // settled business and a new one is opened; only a LIVE run is handed back.
    const outcome = await maybeCreateRuleRunForWorkOrder(db, record.id, { requireRule: false, restart: true }).catch(() => "skipped" as const);
    if (outcome === "created") return { handled: true, reply: toGsm7("Ready. Reply Y to text your vendors, or N to cancel") };
    if (outcome === "existing") return { handled: true, reply: toGsm7("That repair is already with dispatch. Reply Y when it asks you") };
    if (outcome === "no_vendors") return { handled: true, reply: toGsm7("None of your vendors can be texted for that repair. Add one in PropLane") };
    if (outcome === "refused") return { handled: true, reply: toGsm7("That one could not be dispatched. Open PropLane to continue") };
  }
  return { handled: false };
}

/**
 * `Y`, `N`, `Y 7`, `2`, `2 7`, `R`, `B`: the manager's answer to an approval, a held quote,
 * a texted invoice or an exhausted chain. With two items pending a bare answer is refused
 * and the handles are listed, so a stale or hasty Y can never approve the wrong job.
 */
export async function handleManagerDispatchReply(
  db: SupabaseClient,
  input: {
    ownerUserId: string;
    workspaceId: string | null;
    actorUserId: string;
    body: string;
    now?: Date;
    /** The texting phone, for the per-phone wrong-code budget on the PropLane line. */
    fromPhone?: string | null;
    /** Test seam: is an assistant confirmation also waiting for this person? */
    assistantProposalOpen?: () => Promise<boolean>;
    /**
     * The service manager answers for EVERY PropLane Service workspace at once: each scope is one workspace and its owner.
     * Handles come from one counter across the service (`createDispatchRun`), so a handle names exactly one run.
     */
    scopes?: Array<{ ownerUserId: string; workspaceId: string | null }>;
  },
): Promise<InboundHandled> {
  if (isDispatchKeyword(input.body)) return handleDispatchKeyword(db, input);
  const parsed = parseManagerDispatchReply(input.body);
  if (!parsed) return { handled: false };
  const pending = input.scopes
    ? (await Promise.all(input.scopes.map((scope) => listPendingForActor(db, { ...scope, actorUserId: input.actorUserId }).catch(() => [] as PendingItem[]))))
        .flat()
        .sort((a, b) => b.run.handle - a.run.handle)
    : await listPendingForActor(db, input).catch(() => [] as PendingItem[]);
  if (pending.length === 0) return { handled: false };

  const applicable = pending.filter((item) => APPLICABLE[parsed.kind].includes(item.kind));
  let target: PendingItem | undefined;
  // The code presented with this answer: the second number ("Y 7 4821"), or a lone 4-digit number that names no
  // open job ("Y 4821" with one job waiting).
  let presentedCode: string | null = parsed.code;
  if (parsed.handle != null) {
    target = pending.find((item) => item.run.handle === parsed.handle);
    if (!target && parsed.codeCandidate && applicable.length === 1) {
      target = applicable[0]!;
      presentedCode = parsed.codeCandidate;
    }
    if (!target) {
      const open = pending.slice(0, 3).map((item) => `#${item.run.handle}`).join(", ");
      return { handled: true, reply: toGsm7(`No open job #${parsed.handle}. Waiting on you: ${open}`) };
    }
    if (!APPLICABLE[parsed.kind].includes(target.kind)) {
      return { handled: true, reply: toGsm7(`#${target.run.handle} is waiting for ${target.kind === "exhausted" ? "R or B" : "Y or N"}`) };
    }
  } else {
    if (applicable.length === 0) return { handled: false };
    if (applicable.length > 1) {
      const options = applicable.slice(0, 3).map((item) => `${parsed.kind === "decline" ? "N" : "Y"} ${item.run.handle}`);
      return { handled: true, reply: toGsm7(`Which one? Reply ${options.join(" or ")}`) };
    }
    target = applicable[0]!;
    // A hasty Y while an assistant confirmation is also open could mean either: make them say which.
    if (parsed.kind === "approve" || parsed.kind === "decline") {
      const both = await (input.assistantProposalOpen ?? (() => assistantProposalOpen(db, input)))();
      if (both) {
        return {
          handled: true,
          // "@assistant yes" is the existing address that sends a text to the Assistant, so neither can starve the other.
          reply: toGsm7(`Two things are waiting. ${parsed.kind === "decline" ? "N" : "Y"} ${target.run.handle} answers the job. "@assistant ${parsed.kind === "decline" ? "no" : "yes"}" answers the assistant`),
        };
      }
    }
  }
  const { run, kind } = target;
  const actor = { ownerUserId: run.owner_user_id, actorUserId: input.actorUserId, channel: "sms" as const };
  const base = { ...actor, runId: run.id, rawText: input.body.trim().slice(0, 120), now: input.now };

  // On the PropLane line the inbound caller ID proves nothing, so an answer that spends money or texts vendors must
  // repeat the code from its own ask. A bare Y re-asks with a fresh code and costs no attempt; three wrong codes
  // cancel THAT proposal (a later invoice or a new exhaustion gets its own budget).
  const codedKind = CODED_ANSWER_KIND[kind];
  const checked = await checkDispatchApprovalCode(db, run, codedKind, presentedCode, input.fromPhone);
  if (checked === "locked") return { handled: true, reply: toGsm7(`#${run.handle}: ${SMS_CONFIRMATION_LOCKED_REPLY}`) };
  if (checked === "exhausted") {
    if (kind === "approval") await declineDispatchRun(db, base).catch(() => undefined);
    else if (kind === "quote") {
      await decideVendorQuote(db, { ...actor, runId: run.id, approve: false, rawText: base.rawText, now: input.now }).catch(() => undefined);
    } else if (kind === "invoice") {
      await decideRunInvoice(db, { ...actor, runId: run.id, approve: false, rawText: base.rawText, now: input.now }).catch(() => undefined);
    }
    // The cancelled proposal's code dies with it, so the NEXT ask - the vendor texting that invoice again, or the
    // manager's next R / B on a chain nobody took - opens with its own three guesses instead of inheriting a spent
    // budget. Keeping the exhausted chain's row made R and B permanently unanswerable by text: its proposal id only
    // changes when a retry succeeds, which the spent budget was the very thing preventing. Nothing was committed by
    // a wrong code, so a fresh budget costs nothing and "start again when you are ready" is true for every kind.
    await clearDispatchApprovalCode(db, run, codedKind).catch(() => undefined);
    return { handled: true, reply: toGsm7(`#${run.handle}: ${SMS_CONFIRMATION_CANCELLED_REPLY}`) };
  }
  if (checked === "unavailable") {
    return { handled: true, reply: toGsm7(`I could not check that code. Answer #${run.handle} in PropLane`) };
  }
  if (checked === "wrong") {
    const fresh = await reaskDispatchApprovalCode(db, run, codedKind);
    if (!fresh) return { handled: true, reply: toGsm7(`I could not send a code for #${run.handle}. Answer it in PropLane`) };
    const prefix = presentedCode ? "That code does not match. " : "";
    const vendorNames = codedKind === "dispatch_approval" ? await dispatchApprovalVendorNames(db, run) : [];
    return {
      handled: true,
      reply: toGsm7(`${prefix}#${run.handle} needs its code: ${codedAnswerLine(codedKind, run.handle, fresh, { vendorNames, mode: run.mode })}`),
    };
  }

  if (kind === "approval") {
    if (parsed.kind === "decline") {
      const result = await declineDispatchRun(db, base);
      return { handled: true, reply: result.ok ? `Declined #${run.handle}. Nobody was texted.` : describeFailure(result.reason, run.handle) };
    }
    const position = parsed.kind === "pick" ? parsed.position - 1 : null;
    const result = await approveDispatchRun(db, { ...base, pickPosition: position });
    if (!result.ok && result.reason === "no_vendors" && parsed.kind === "pick") {
      return { handled: true, reply: toGsm7(`#${run.handle} has no vendor number ${parsed.position}`) };
    }
    return { handled: true, reply: result.ok ? `Approved #${run.handle}. Texting now.` : describeFailure(result.reason, run.handle) };
  }
  if (kind === "quote") {
    const result = await decideVendorQuote(db, { ownerUserId: run.owner_user_id, actorUserId: input.actorUserId, runId: run.id, approve: parsed.kind === "approve", rawText: base.rawText, channel: "sms", now: input.now });
    return { handled: true, reply: result.ok ? (parsed.kind === "approve" ? `Approved the price on #${run.handle}.` : `Declined the price on #${run.handle}. Trying the next vendor.`) : describeFailure(result.reason, run.handle) };
  }
  if (kind === "invoice") {
    const result = await decideRunInvoice(db, { ownerUserId: run.owner_user_id, actorUserId: input.actorUserId, runId: run.id, approve: parsed.kind === "approve", rawText: base.rawText, now: input.now });
    if (result.ok && parsed.kind === "approve") {
      const tail =
        result.settled === "posted" ? " The vendor is being paid."
        : result.settled === "waiting_owner" ? " It is over the owner's repair limit, so the owner was asked. You will hear when they answer."
        : result.settled === "declined" ? " The owner declined this repair."
        : result.settled === "unavailable" ? " Open PropLane to finish paying it."
        : " Pay it from the service record.";
      return { handled: true, reply: toGsm7(`Invoice on #${run.handle} approved.${tail}`) };
    }
    return { handled: true, reply: result.ok ? `Invoice on #${run.handle} declined.` : describeFailure(result.reason, run.handle) };
  }
  const result = await retryDispatchRun(db, { ...base, broadcast: parsed.kind === "broadcast" });
  return { handled: true, reply: result.ok ? `Retrying #${run.handle}${parsed.kind === "broadcast" ? " with every vendor of the trade" : ""}.` : describeFailure(result.reason, run.handle) };
}

type VendorJob = { run: DispatchRunRow; attempt: DispatchAttemptRow; contact: VendorContact };

/** Every job this phone is currently offered or has accepted, for this owner and workspace. */
export async function findVendorJobsForPhone(
  db: SupabaseClient,
  input: { ownerUserId: string; workspaceId: string | null; phoneE164: string },
): Promise<VendorJob[]> {
  const phone = normalizeE164(input.phoneE164);
  if (!phone) return [];
  const scope = await replyScope(db, input.ownerUserId, input.workspaceId);
  const runs = await loadOwnerRuns(db, scope.owners, scope.workspaces, ["offering", "exhausted", "accepted"], { completed: "recent" });
  if (runs.length === 0) return [];
  const runById = new Map(runs.map((run) => [run.id, run] as const));
  const { data, error } = await db
    .from("vendor_dispatch_attempts")
    .select("*")
    .in("run_id", [...runById.keys()])
    .in("status", ["offered", "timed_out", "accepted"]);
  if (error) {
    if (isMissingRelationError(error)) return [];
    throw new Error(error.message);
  }
  const attempts = (data ?? []) as DispatchAttemptRow[];
  // Contacts are re-read per run owner: a vendor is a contact of the run's owner (or the service owner's roster).
  const contactsByOwner = new Map<string, Map<string, VendorContact>>();
  for (const owner of new Set(runs.map((run) => run.owner_user_id))) {
    const ids = [...new Set(attempts.filter((attempt) => runById.get(attempt.run_id)?.owner_user_id === owner).map((attempt) => attempt.vendor_directory_id))];
    contactsByOwner.set(owner, await loadVendorContacts(db, owner, ids));
  }
  const jobs: VendorJob[] = [];
  for (const attempt of attempts) {
    const run = runById.get(attempt.run_id);
    const contact = run ? contactsByOwner.get(run.owner_user_id)?.get(attempt.vendor_directory_id) : undefined;
    if (!contact || !run || contact.phone !== phone) continue;
    jobs.push({ run, attempt, contact });
  }
  return jobs.sort((a, b) => b.run.handle - a.run.handle);
}

function selectJobs(parsed: VendorDispatchReply, jobs: VendorJob[]): VendorJob[] {
  const offered = (job: VendorJob) =>
    (job.attempt.status === "offered" || job.attempt.status === "timed_out") && (job.run.status === "offering" || job.run.status === "exhausted");
  const accepted = (job: VendorJob) => job.attempt.status === "accepted" && ["accepted", "completed"].includes(job.run.status);
  const pool =
    parsed.kind === "done"
      ? jobs.filter((job) => accepted(job) && job.run.status === "accepted")
      : parsed.kind === "invoice"
        ? jobs.filter(accepted)
        : jobs.filter(offered);
  return parsed.handle != null ? pool.filter((job) => job.run.handle === parsed.handle) : pool;
}

async function tellVendor(db: SupabaseClient, job: VendorJob, fallbackPhone: string, text: string, key: string, messageSid: string): Promise<void> {
  await sendVendorDispatchText(db, {
    ownerUserId: job.run.owner_user_id,
    workspaceId: job.run.workspace_id,
    vendorDirectoryId: job.contact.id,
    phone: job.contact.phone ?? fallbackPhone,
    vendorUserId: job.contact.vendorUserId,
    text,
    idempotencyKey: `dispatch-reply-${key}-${messageSid}`.slice(0, 128),
  }).catch(() => undefined);
}

/**
 * Put the photos of one inbound text on the job: a work-order service gets them as completion photos
 * (and the files link to it); any other kind of run just links the files to the run. Returns how many
 * files were attached. Scoped to the run's own owner; files from another owner's bucket path never match.
 */
async function attachRunMedia(db: SupabaseClient, job: VendorJob, messageSid: string): Promise<number> {
  const run = job.run;
  let linked = 0;
  if (run.source_type === "work_order") {
    linked = (await attachVendorJobMedia(db, { ownerUserId: run.owner_user_id, workOrderId: run.source_id, messageSid })).linked;
  }
  if (linked === 0) linked = await linkVendorRunMedia(db, { ownerUserId: run.owner_user_id, runId: run.id, messageSid });
  if (linked > 0) {
    await recordDispatchEvent(db, { ownerUserId: run.owner_user_id, runId: run.id, handle: run.handle, event: "vendor_photos", key: messageSid, detail: { photos: linked }, channel: "sms" });
  }
  return linked;
}

/**
 * Does this text answer a live dispatch offer this phone holds? The PropLane-line handlers that run BEFORE the
 * dispatch fork ask this first: a member of a workspace who is also a dispatched vendor (an owner who does their own
 * handyman work) replying NO was answered with the status help menu, so the offer was never declined and the job
 * stalled until it timed out. Read-only, and false for anyone with nothing offered.
 */
export async function hasLiveVendorDispatchAnswer(
  db: SupabaseClient,
  input: { ownerUserId: string; workspaceId: string | null; phoneE164: string; body: string },
): Promise<boolean> {
  const parsed = parseVendorDispatchReply(input.body);
  if (!parsed) return false;
  const jobs = await findVendorJobsForPhone(db, input).catch(() => [] as VendorJob[]);
  return selectJobs(parsed, jobs).length > 0;
}

/**
 * A text from a phone that is on a dispatch: `YES [time] [$price]`, `NO`, `BUSY [2h]`,
 * `DONE`, `INVOICE $amount`. Several open offers need the job number ("YES 7"); the vendor
 * is asked which. Anything else is not ours and reaches the vendor agent as before.
 */
export async function handleVendorDispatchReply(
  db: SupabaseClient,
  input: {
    ownerUserId: string;
    workspaceId: string | null;
    phoneE164: string;
    body: string;
    messageSid: string;
    /** `NumMedia` of the inbound text: photos that ride a DONE belong to the job. */
    mediaCount?: number;
    now?: Date;
  },
): Promise<InboundHandled & { vendorUserId?: string | null }> {
  const parsed = parseVendorDispatchReply(input.body);
  if (!parsed) return { handled: false };
  const jobs = await findVendorJobsForPhone(db, input).catch(() => [] as VendorJob[]);
  if (jobs.length === 0) return { handled: false };
  const candidates = selectJobs(parsed, jobs);
  if (candidates.length === 0) return { handled: false };

  const first = candidates[0]!;
  const tell = (job: VendorJob, text: string, key: string) => tellVendor(db, job, input.phoneE164, text, key, input.messageSid);
  if (candidates.length > 1) {
    const verb = parsed.kind === "yes" ? "YES" : parsed.kind === "no" ? "NO" : parsed.kind === "busy" ? "BUSY" : parsed.kind === "done" ? "DONE" : "INVOICE";
    const options = candidates.slice(0, 3).map((job) => `${verb} ${job.run.handle}`);
    await tell(first, toGsm7(`Which job? Reply ${options.join(" or ")}`), "which");
    return { handled: true, vendorUserId: first.contact.vendorUserId };
  }

  const raw = input.body.trim().slice(0, 120);
  const ownerUserId = first.run.owner_user_id;
  const now = input.now;
  if (parsed.kind === "yes") {
    await recordVendorYes(db, { ownerUserId, attemptId: first.attempt.id, timeText: parsed.timeText, priceCents: parsed.priceCents, rawText: raw, now });
  } else if (parsed.kind === "no") {
    await recordVendorNo(db, { ownerUserId, attemptId: first.attempt.id, rawText: raw, now });
  } else if (parsed.kind === "busy") {
    await recordVendorBusy(db, { ownerUserId, attemptId: first.attempt.id, minutes: parsed.minutes, rawText: raw, now });
  } else if (parsed.kind === "done") {
    // "DONE" with photos: the photos are the proof of work, so they land on the job before anyone is told it is done.
    if ((input.mediaCount ?? 0) > 0) await attachRunMedia(db, first, input.messageSid).catch(() => 0);
    const outcome = await recordVendorDone(db, { ownerUserId, attemptId: first.attempt.id, note: parsed.note, now });
    if (outcome === "marked_done") await tell(first, `Thanks, #${first.run.handle} is marked done. Reply INVOICE $amount to bill it`, "done");
  } else {
    const outcome = await recordVendorInvoice(db, { ownerUserId, attemptId: first.attempt.id, amountCents: parsed.amountCents, now });
    await tell(
      first,
      outcome === "asked" ? `Got it, sent your invoice for #${first.run.handle} to the manager` : `Could not take that invoice for #${first.run.handle}`,
      "invoice",
    );
  }
  return { handled: true, vendorUserId: first.contact.vendorUserId };
}

/** A resident's bare YES / NO while a finished job waits on "Is it fixed?". */
export async function handleResidentDispatchReply(
  db: SupabaseClient,
  input: { ownerUserId: string; residentEmail: string; body: string; now?: Date },
): Promise<InboundHandled> {
  const verdict = parseResidentFixedReply(input.body);
  if (!verdict) return { handled: false };
  const result = await handleResidentFixedReply(db, { ownerUserId: input.ownerUserId, residentEmail: input.residentEmail, verdict, now: input.now }).catch(
    () => ({ handled: false as const }),
  );
  return result.handled ? { handled: true, reply: result.reply } : { handled: false };
}


/**
 * A photo from a vendor who has accepted a dispatched job (no DONE/INVOICE word with it): the
 * before/after pictures. They go on the job, the vendor is told, and the text never reaches another
 * agent (a vendor with no PropLane login has no vendor session, so the prospect agent would answer it).
 * Several accepted jobs need a "#7" in the text. `handled: false` = this phone has no accepted job.
 */
export async function handleVendorDispatchMedia(
  db: SupabaseClient,
  input: { ownerUserId: string; workspaceId: string | null; phoneE164: string; body: string; messageSid: string; mediaCount: number; now?: Date },
): Promise<InboundHandled & { vendorUserId?: string | null }> {
  if (!(input.mediaCount > 0)) return { handled: false };
  const all = await findVendorJobsForPhone(db, input).catch(() => [] as VendorJob[]);
  const jobs = all.filter((job) => job.attempt.status === "accepted" && ["accepted", "completed"].includes(job.run.status));
  if (jobs.length === 0) return { handled: false };

  const named = /#\s*(\d{1,6})\b/.exec(input.body) ?? /\bjob\s+(\d{1,6})\b/i.exec(input.body);
  const open = jobs.filter((job) => job.run.status === "accepted");
  const job = named
    ? jobs.find((candidate) => candidate.run.handle === Number(named[1]))
    : open.length === 1
      ? open[0]
      : jobs.length === 1
        ? jobs[0]
        : undefined;
  const tell = (target: VendorJob, text: string, key: string) => tellVendor(db, target, input.phoneE164, text, key, input.messageSid);
  if (!job) {
    const options = jobs.slice(0, 3).map((candidate) => `#${candidate.run.handle}`).join(" or ");
    await tell(jobs[0]!, toGsm7(`Which job are these photos for? Send them again with the job number, like ${options}`), "photos-which");
    return { handled: true, vendorUserId: jobs[0]!.contact.vendorUserId };
  }
  const linked = await attachRunMedia(db, job, input.messageSid).catch(() => 0);
  const text =
    linked === 0
      ? `Could not save that photo for #${job.run.handle}. Please send it again`
      : job.run.status === "completed"
        ? `Got it, ${linked === 1 ? "photo" : `${linked} photos`} added to #${job.run.handle}`
        : `Got your ${linked === 1 ? "photo" : `${linked} photos`} for #${job.run.handle}. Reply DONE when the job is finished`;
  await tell(job, text, "photos");
  return { handled: true, vendorUserId: job.contact.vendorUserId };
}
