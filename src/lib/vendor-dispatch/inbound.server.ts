import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { readPortalAssistantSmsSession } from "@/lib/agent/portal-assistant-session.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { classifySmsConfirmationReply, resolveOpenSmsProposal } from "@/lib/sms/agent-confirmation.server";
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
import { approveDispatchRun, declineDispatchRun, retryDispatchRun } from "@/lib/vendor-dispatch/runs.server";
import { decideVendorQuote, recordVendorBusy, recordVendorNo, recordVendorYes } from "@/lib/vendor-dispatch/responses.server";
import { sendVendorDispatchText } from "@/lib/vendor-dispatch/send.server";
import { toGsm7 } from "@/lib/vendor-dispatch/text";
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

async function loadOwnerRuns(
  db: SupabaseClient,
  ownerUserId: string,
  workspaceId: string | null,
  statuses: string[],
): Promise<DispatchRunRow[]> {
  const { data, error } = await db
    .from("vendor_dispatch_runs")
    .select("*")
    .eq("owner_user_id", ownerUserId)
    .in("status", statuses);
  if (error) {
    if (isMissingRelationError(error)) return [];
    throw new Error(error.message);
  }
  return ((data ?? []) as DispatchRunRow[]).filter((run) => !workspaceId || run.workspace_id === workspaceId);
}

/** Everything awaiting THIS person's answer, newest first. */
export async function listPendingForActor(
  db: SupabaseClient,
  input: { ownerUserId: string; workspaceId: string | null; actorUserId: string },
): Promise<PendingItem[]> {
  const runs = await loadOwnerRuns(db, input.ownerUserId, input.workspaceId, ["awaiting_approval", "offering", "exhausted", "accepted", "completed"]);
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

const APPLICABLE: Record<ManagerDispatchReply["kind"], PendingKind[]> = {
  approve: ["approval", "quote", "invoice"],
  decline: ["approval", "quote", "invoice"],
  pick: ["approval"],
  retry: ["exhausted"],
  broadcast: ["exhausted"],
};

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
    /** Test seam: is an assistant confirmation also waiting for this person? */
    assistantProposalOpen?: () => Promise<boolean>;
  },
): Promise<InboundHandled> {
  const parsed = parseManagerDispatchReply(input.body);
  if (!parsed) return { handled: false };
  const pending = await listPendingForActor(db, input).catch(() => [] as PendingItem[]);
  if (pending.length === 0) return { handled: false };

  const applicable = pending.filter((item) => APPLICABLE[parsed.kind].includes(item.kind));
  let target: PendingItem | undefined;
  if (parsed.handle != null) {
    target = pending.find((item) => item.run.handle === parsed.handle);
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
          reply: toGsm7(`Two things are waiting. Reply ${parsed.kind === "decline" ? "N" : "Y"} ${target.run.handle} for the job, or answer the assistant after`),
        };
      }
    }
  }
  const { run, kind } = target;
  const actor = { ownerUserId: run.owner_user_id, actorUserId: input.actorUserId, channel: "sms" as const };
  const base = { ...actor, runId: run.id, rawText: input.body.trim().slice(0, 120), now: input.now };

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
    return { handled: true, reply: result.ok ? (parsed.kind === "approve" ? `Invoice on #${run.handle} approved.` : `Invoice on #${run.handle} declined.`) : describeFailure(result.reason, run.handle) };
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
  const runs = await loadOwnerRuns(db, input.ownerUserId, input.workspaceId, ["offering", "exhausted", "accepted", "completed"]);
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
  const contacts = await loadVendorContacts(db, input.ownerUserId, [...new Set(attempts.map((attempt) => attempt.vendor_directory_id))]);
  const jobs: VendorJob[] = [];
  for (const attempt of attempts) {
    const contact = contacts.get(attempt.vendor_directory_id);
    const run = runById.get(attempt.run_id);
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
  const tell = async (job: VendorJob, text: string, key: string) => {
    await sendVendorDispatchText(db, {
      ownerUserId: job.run.owner_user_id,
      workspaceId: job.run.workspace_id,
      vendorDirectoryId: job.contact.id,
      phone: job.contact.phone ?? input.phoneE164,
      vendorUserId: job.contact.vendorUserId,
      text,
      idempotencyKey: `dispatch-reply-${key}-${input.messageSid}`.slice(0, 128),
    }).catch(() => undefined);
  };
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

export { classifySmsConfirmationReply };
