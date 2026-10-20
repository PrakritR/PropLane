import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import { notifyVendorOfInvoiceDecision } from "@/lib/vendor-invoice-decision-notify.server";
import { createBillFromVendorInvoice } from "@/lib/manager-bills.server";
import { assertFinancialsTier } from "@/lib/reports/auth";
import { stampSmsTestProvenance } from "@/lib/sms/sms-test-provenance.server";
import { insertVendorInvoiceRow, prepareVendorInvoiceSubmission } from "@/lib/vendor-invoice-submit.server";
import { ensureSubmittedVendorInvoiceForMarkedDone } from "@/lib/work-order-vendor-invoice.server";
import { requestResidentConfirmation, resolveResidentConfirmationBySms } from "@/lib/work-order-resident-confirmation.server";
import { workOrderEvent } from "@/lib/work-order-events.server";
import { recordDispatchEvent } from "@/lib/vendor-dispatch/audit.server";
import { canActorApprove, loadAttempts, loadRun, loadVendorContacts, notifyApprovers, notifyOutcome } from "@/lib/vendor-dispatch/engine.server";
import { sendResidentDispatchText, sendVendorDispatchText } from "@/lib/vendor-dispatch/send.server";
import {
  composeInvoiceAskText,
  composeManagerDoneText,
  composeManagerNotFixedText,
  composeResidentFixedAsk,
  toGsm7,
} from "@/lib/vendor-dispatch/text";
import type { DispatchRunRow } from "@/lib/vendor-dispatch/types";
import { applyApprovedDispatchInvoice, setServiceVendorCost, type ApprovedInvoiceOutcome } from "@/lib/vendor-dispatch/invoice-managed.server";

/**
 * After the accept: DONE, "is it fixed?", and the invoice (vendor-dispatch-1018).
 * The service row carries the same fields the vendor portal's "mark done" writes, so
 * the manager list, the record and the resident portal agree with the text thread.
 * Nothing here pays anyone: an invoice only reaches the existing vendor-invoice rails
 * as a submitted invoice, and approval creates the bill exactly as the portal does.
 */

async function readWorkOrder(db: SupabaseClient, run: DispatchRunRow) {
  const { data } = await db
    .from("portal_work_order_records")
    .select("id, manager_user_id, vendor_user_id, row_data")
    .eq("id", run.source_id)
    .eq("manager_user_id", run.owner_user_id)
    .maybeSingle();
  return (data as { id: string; manager_user_id: string; vendor_user_id: string | null; row_data: DemoManagerWorkOrderRow } | null) ?? null;
}

async function ownerSender(db: SupabaseClient, ownerUserId: string) {
  const { data } = await db.from("profiles").select("email, full_name").eq("id", ownerUserId).maybeSingle();
  return {
    userId: ownerUserId,
    email: String((data as { email?: unknown } | null)?.email ?? "").trim().toLowerCase(),
    fullName: String((data as { full_name?: unknown } | null)?.full_name ?? "").trim() || "PropLane",
  };
}

export type DoneOutcome = "marked_done" | "already" | "not_accepted_vendor" | "not_found";

/** The accepted vendor texted DONE. */
export async function recordVendorDone(
  db: SupabaseClient,
  input: { ownerUserId: string; attemptId: string; note?: string | null; now?: Date },
): Promise<DoneOutcome> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const { data: attemptRow } = await db.from("vendor_dispatch_attempts").select("*").eq("id", input.attemptId).maybeSingle();
  const attempt = attemptRow as { id: string; run_id: string; vendor_directory_id: string; status: string } | null;
  if (!attempt) return "not_found";
  const run = await loadRun(db, attempt.run_id);
  if (!run || run.owner_user_id !== input.ownerUserId) return "not_found";
  if (run.status !== "accepted" || run.accepted_vendor_directory_id !== attempt.vendor_directory_id || attempt.status !== "accepted") {
    return "not_accepted_vendor";
  }
  if (run.completion_state === "awaiting_resident" || run.completion_state === "confirmed") return "already";

  const residentEmail = (run.resident_email ?? "").trim().toLowerCase();
  const waitsForResident = Boolean(residentEmail) && run.source_type === "work_order";
  const { data: claimed } = await db
    .from("vendor_dispatch_runs")
    .update({
      vendor_done_at: nowIso,
      updated_at: nowIso,
      ...(waitsForResident
        ? { completion_state: "awaiting_resident" }
        : { status: "completed", completion_state: "confirmed", completed_at: nowIso }),
    })
    .eq("id", run.id)
    .eq("status", "accepted")
    .select("id");
  if (!claimed || (claimed as unknown[]).length === 0) return "already";

  const contacts = await loadVendorContacts(db, run.owner_user_id, [attempt.vendor_directory_id]);
  const contact = contacts.get(attempt.vendor_directory_id);
  await recordDispatchEvent(db, { ownerUserId: run.owner_user_id, runId: run.id, handle: run.handle, event: "vendor_done", key: attempt.id, reply: input.note ?? null, now });

  if (run.source_type === "work_order") {
    const record = await readWorkOrder(db, run);
    if (record) {
      const row = record.row_data;
      let next: DemoManagerWorkOrderRow = {
        ...row,
        // A vendor who says DONE was there: an Assigned service moves to Scheduled first, as the portal requires.
        ...(row.bucket === "open" ? { bucket: "scheduled" as const, status: "Scheduled" } : {}),
        automationStatus: "vendor_marked_done",
        vendorMarkedDoneAt: nowIso,
        vendorMarkedDoneNote: input.note?.trim().slice(0, 2000) || undefined,
      };
      await db
        .from("portal_work_order_records")
        .update({ row_data: stampSmsTestProvenance(next as unknown as Record<string, unknown>), updated_at: nowIso })
        .eq("id", run.source_id)
        .eq("manager_user_id", run.owner_user_id);
      const confirmation = await requestResidentConfirmation(db, run.source_id, run.owner_user_id, next).catch(() => null);
      next = confirmation?.rowData ?? next;
      const sender = await ownerSender(db, run.owner_user_id);
      await workOrderEvent(db, {
        eventId: `${run.source_id}:completed:dispatch-run:${run.id}`,
        event: "completed",
        senderAudience: "vendor",
        managerUserId: run.owner_user_id,
        workOrderId: run.source_id,
        senderUserId: sender.userId,
        senderEmail: sender.email,
        senderName: contact?.name || row.vendorName || sender.fullName,
        facts: {
          reference: row.reference || "Service",
          propertyId: row.assignedPropertyId || row.propertyId || undefined,
          title: row.title || "Service",
          propertyLabel: row.propertyName || undefined,
          vendorName: contact?.name || row.vendorName || undefined,
          confirmUrl: confirmation?.confirmUrl,
        },
        recipients: [{ audience: "manager", userId: run.owner_user_id }],
      }).catch(() => undefined);
      if (contact?.vendorUserId) {
        await ensureSubmittedVendorInvoiceForMarkedDone(db, {
          workOrderId: run.source_id,
          managerUserId: run.owner_user_id,
          vendorUserId: contact.vendorUserId,
          row: next,
        }).catch(() => undefined);
      }
    }
  }

  if (waitsForResident) {
    await sendResidentDispatchText(db, {
      ownerUserId: run.owner_user_id,
      workspaceId: run.workspace_id,
      residentEmail,
      text: composeResidentFixedAsk(),
      dedupeKey: `dispatch-resident-fixed-ask-${run.id}`,
    }).catch(() => undefined);
  }
  await notifyOutcome(
    db,
    run,
    waitsForResident
      ? composeManagerDoneText({ handle: run.handle, vendorName: contact?.name ?? "Vendor" })
      : toGsm7(`${contact?.firstName ?? "Vendor"} finished #${run.handle}`),
    "done",
  );
  return "marked_done";
}

export type ResidentFixedOutcome = { handled: false } | { handled: true; reply: string };

/**
 * The resident's YES / NO to "Is it fixed?". YES completes the service; NO reopens it for
 * the vendor and alerts the manager. Only a resident whose email is on a run waiting for
 * that answer is claimed, so an ordinary YES still reaches the resident agent.
 */
export async function handleResidentFixedReply(
  db: SupabaseClient,
  input: { ownerUserId: string; residentEmail: string; verdict: "fixed" | "not_fixed"; now?: Date },
): Promise<ResidentFixedOutcome> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const email = input.residentEmail.trim().toLowerCase();
  if (!email) return { handled: false };
  const { data } = await db
    .from("vendor_dispatch_runs")
    .select("*")
    .eq("owner_user_id", input.ownerUserId)
    .eq("resident_email", email)
    .eq("completion_state", "awaiting_resident")
    .eq("status", "accepted");
  const runs = ((data ?? []) as DispatchRunRow[]).sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
  const run = runs[0];
  if (!run) return { handled: false };

  const nextState = input.verdict === "fixed" ? "confirmed" : "reopened";
  const { data: claimed } = await db
    .from("vendor_dispatch_runs")
    .update(
      input.verdict === "fixed"
        ? { status: "completed", completion_state: nextState, completed_at: nowIso, updated_at: nowIso }
        : { completion_state: nextState, vendor_done_at: null, updated_at: nowIso },
    )
    .eq("id", run.id)
    .eq("completion_state", "awaiting_resident")
    .select("id");
  if (!claimed || (claimed as unknown[]).length === 0) return { handled: false };

  // The existing confirmation (when the manager has that step on) sends its own notices; run it first, then layer our fields.
  await resolveResidentConfirmationBySms(db, {
    managerUserId: run.owner_user_id,
    residentEmail: email,
    verdict: input.verdict,
    now,
  }).catch(() => null);

  const record = await readWorkOrder(db, run);
  const houseLabel = String(run.details.houseLabel || run.details.area || "the house");
  if (record) {
    const row = record.row_data;
    const next: DemoManagerWorkOrderRow =
      input.verdict === "fixed"
        ? {
            ...row,
            bucket: "completed",
            status: "Completed",
            completedAt: nowIso,
            ...(row.vendorCostCents == null && run.agreed_cents != null ? { vendorCostCents: run.agreed_cents } : {}),
          }
        : { ...row, automationStatus: undefined, vendorMarkedDoneAt: undefined, reopenedAt: nowIso };
    await db
      .from("portal_work_order_records")
      .update({ row_data: stampSmsTestProvenance(next as unknown as Record<string, unknown>), updated_at: nowIso })
      .eq("id", run.source_id)
      .eq("manager_user_id", run.owner_user_id);
  }

  await recordDispatchEvent(db, {
    ownerUserId: run.owner_user_id,
    runId: run.id,
    handle: run.handle,
    event: input.verdict === "fixed" ? "resident_confirmed" : "resident_reopened",
    channel: "sms",
    detail: { verdict: input.verdict },
    now,
  });

  if (input.verdict === "fixed") {
    await notifyOutcome(db, run, toGsm7(`Resident confirmed #${run.handle} is fixed. Service completed`), "fixed");
    return { handled: true, reply: "Thanks, glad it is fixed. Your service is closed." };
  }
  await notifyOutcome(db, run, composeManagerNotFixedText({ handle: run.handle, houseLabel }), "not-fixed");
  if (run.accepted_vendor_directory_id) {
    const contacts = await loadVendorContacts(db, run.owner_user_id, [run.accepted_vendor_directory_id]);
    const contact = contacts.get(run.accepted_vendor_directory_id);
    if (contact?.phone) {
      await sendVendorDispatchText(db, {
        ownerUserId: run.owner_user_id,
        workspaceId: run.workspace_id,
        vendorDirectoryId: contact.id,
        phone: contact.phone,
        vendorUserId: contact.vendorUserId,
        text: `The resident says #${run.handle} is not fixed yet. Please follow up, then reply DONE`,
        idempotencyKey: `dispatch-reopen-${run.id}-${nowIso.slice(0, 16).replace(/[^0-9]/g, "")}`,
      }).catch(() => undefined);
    }
  }
  return { handled: true, reply: "Sorry about that. Your property manager has been told and the service is reopened." };
}

export type InvoiceOutcome = "asked" | "not_accepted_vendor" | "not_found" | "invalid" | "already_pending";

/**
 * The accepted vendor texted an invoice amount. A vendor with a PropLane login gets a real
 * submitted invoice on the existing rails; either way the manager answers Y / N by text.
 */
export async function recordVendorInvoice(
  db: SupabaseClient,
  input: { ownerUserId: string; attemptId: string; amountCents: number; now?: Date },
): Promise<InvoiceOutcome> {
  const now = input.now ?? new Date();
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0 || input.amountCents > 100_000_00) return "invalid";
  const { data: attemptRow } = await db.from("vendor_dispatch_attempts").select("*").eq("id", input.attemptId).maybeSingle();
  const attempt = attemptRow as { id: string; run_id: string; vendor_directory_id: string; status: string } | null;
  if (!attempt) return "not_found";
  const run = await loadRun(db, attempt.run_id);
  if (!run || run.owner_user_id !== input.ownerUserId) return "not_found";
  if (run.accepted_vendor_directory_id !== attempt.vendor_directory_id || attempt.status !== "accepted") return "not_accepted_vendor";
  if (!["accepted", "completed"].includes(run.status)) return "not_accepted_vendor";
  if (run.pending_invoice_cents != null) return "already_pending";

  const contacts = await loadVendorContacts(db, run.owner_user_id, [attempt.vendor_directory_id]);
  const contact = contacts.get(attempt.vendor_directory_id);
  // Claim the run BEFORE the invoice row exists. The read above is not atomic, so two quick "INVOICE $240"
  // texts both passed it; inserting first left the loser's submitted invoice live on the vendor-invoice rails,
  // approvable later as a second bill against the owner and invisible to `details.invoiceId`.
  const { data: claimed } = await db
    .from("vendor_dispatch_runs")
    .update({
      pending_invoice_cents: input.amountCents,
      details: { ...run.details, invoiceId: null },
      approval_reminded_at: null,
      updated_at: now.toISOString(),
    })
    .eq("id", run.id)
    .is("pending_invoice_cents", null)
    .select("id");
  if (!claimed || (claimed as unknown[]).length === 0) return "already_pending";

  let invoiceId: string | null = null;
  if (contact?.vendorUserId) {
    try {
      const prepared = await prepareVendorInvoiceSubmission(db, contact.vendorUserId, {
        managerUserId: run.owner_user_id,
        workOrderId: run.source_type === "work_order" ? run.source_id : undefined,
        lineItems: [
          { description: String(run.details.what || "Service"), quantity: 1, unitAmountCents: input.amountCents },
        ],
      });
      const inserted = await insertVendorInvoiceRow(db, prepared, {
        vendorUserId: contact.vendorUserId,
        memo: `Texted by the vendor on job #${run.handle}`,
        now: now.toISOString(),
      });
      invoiceId = (inserted as { data?: { id?: string } | null }).data?.id ?? null;
    } catch (error) {
      console.error("vendor dispatch invoice not filed", error instanceof Error ? error.message : "unknown");
    }
  }
  if (invoiceId) {
    await db
      .from("vendor_dispatch_runs")
      .update({ details: { ...run.details, invoiceId }, updated_at: now.toISOString() })
      .eq("id", run.id);
  }
  await recordDispatchEvent(db, { ownerUserId: run.owner_user_id, runId: run.id, handle: run.handle, event: "invoice_asked", key: attempt.id, detail: { amountCents: input.amountCents, invoiceId }, now });
  const { dispatchProposalId, withDispatchApprovalCode } = await import("@/lib/vendor-dispatch/approval-code.server");
  await notifyApprovers(db, { ...run, details: { ...run.details, invoiceId } }, {
    audience: "everyone",
    text: await withDispatchApprovalCode(
      db,
      run,
      "dispatch_invoice",
      (instruction) => composeInvoiceAskText({ handle: run.handle, vendorName: contact?.name ?? "Vendor", cents: input.amountCents, instruction }),
      dispatchProposalId({ kind: "dispatch_invoice", attemptId: attempt.id, amountCents: input.amountCents }),
    ),
    key: `invoice-${attempt.id}`,
  });
  return "asked";
}

/** The manager's Y / N on a texted invoice. Approval creates the bill the way the portal does; it never pays. */
export async function decideRunInvoice(
  db: SupabaseClient,
  input: { ownerUserId: string; actorUserId: string; runId: string; approve: boolean; rawText?: string | null; now?: Date },
): Promise<{ ok: true; settled?: ApprovedInvoiceOutcome } | { ok: false; reason: "not_found" | "not_allowed" | "wrong_state" | "tier" | "unavailable" }> {
  const now = input.now ?? new Date();
  const run = await loadRun(db, input.runId);
  if (!run || run.owner_user_id !== input.ownerUserId) return { ok: false, reason: "not_found" };
  if (!(await canActorApprove(db, run, input.actorUserId))) return { ok: false, reason: "not_allowed" };
  if (run.pending_invoice_cents == null) return { ok: false, reason: "wrong_state" };

  const invoiceId = typeof run.details.invoiceId === "string" ? run.details.invoiceId : null;
  if (input.approve) {
    const gate = await assertFinancialsTier(run.owner_user_id);
    if (!gate.ok) return { ok: false, reason: "tier" };
  }
  let approvedAmountCents = Number(run.pending_invoice_cents);
  if (!invoiceId) {
    // No invoice row to claim (the normal case for a roster vendor with no PropLane login): claim the pending
    // amount on the run itself, conditionally, so two Y replies (or a Twilio retry) cannot both post the bill,
    // text the vendor "balance waiting" and write the audit events twice.
    const { data: claimedPending } = await db
      .from("vendor_dispatch_runs")
      .update({ pending_invoice_cents: null, updated_at: now.toISOString() })
      .eq("id", run.id)
      .eq("owner_user_id", run.owner_user_id)
      .eq("pending_invoice_cents", approvedAmountCents)
      .select("id");
    if (!claimedPending || (claimedPending as unknown[]).length === 0) return { ok: false, reason: "wrong_state" };
  }
  // Whichever claim this call took (the invoice row's `submitted` -> `approved` flip, or the run's pending amount),
  // handing it back is what lets the manager's next Y try the same invoice again.
  const restoreInvoiceClaim = async (): Promise<void> => {
    if (invoiceId) {
      await db
        .from("vendor_invoices")
        .update({ status: "submitted", decided_at: null, decided_by: null, updated_at: now.toISOString() })
        .eq("id", invoiceId)
        .eq("manager_user_id", run.owner_user_id)
        .eq("status", "approved")
        .then(undefined, () => undefined);
      return;
    }
    await db
      .from("vendor_dispatch_runs")
      .update({ pending_invoice_cents: approvedAmountCents, updated_at: now.toISOString() })
      .eq("id", run.id)
      .eq("owner_user_id", run.owner_user_id)
      .is("pending_invoice_cents", null)
      .then(undefined, () => undefined);
  };
  let invoiceVendorUserId: string | null = null;
  if (invoiceId) {
    const { data: updated } = await db
      .from("vendor_invoices")
      .update({
        status: input.approve ? "approved" : "rejected",
        decided_at: now.toISOString(),
        decided_by: input.actorUserId,
        updated_at: now.toISOString(),
      })
      .eq("id", invoiceId)
      .eq("manager_user_id", run.owner_user_id)
      .eq("status", "submitted")
      .select("id, vendor_user_id, total_cents, work_order_id");
    const row = ((updated ?? []) as Array<{ id: string; vendor_user_id: string; total_cents: number; work_order_id: string | null }>)[0];
    if (!row) return { ok: false, reason: "wrong_state" };
    invoiceVendorUserId = row.vendor_user_id || null;
    // The invoice row's own total is recomputed server side from its line items; the texted figure is only the fallback.
    if (Number.isSafeInteger(Number(row.total_cents)) && Number(row.total_cents) >= 100) approvedAmountCents = Number(row.total_cents);
    if (input.approve) {
      try {
        await createBillFromVendorInvoice(db, run.owner_user_id, invoiceId);
      } catch {
        // Bill creation needs the invoice to be `approved` already, so the flip above cannot wait for it. Put the
        // invoice back to `submitted` instead: the manager's next Y finds it again rather than being told the
        // invoice is "already handled" with no bill ever created. Bill creation is idempotent on the invoice id.
        await db
          .from("vendor_invoices")
          .update({ status: "submitted", decided_at: null, decided_by: null, updated_at: now.toISOString() })
          .eq("id", invoiceId)
          .eq("manager_user_id", run.owner_user_id)
          .eq("status", "approved");
        return { ok: false, reason: "unavailable" };
      }
    }
    await notifyVendorOfInvoiceDecision(db, {
      managerUserId: run.owner_user_id,
      vendorUserId: row.vendor_user_id,
      invoiceId,
      workOrderId: row.work_order_id,
      totalCents: Number(row.total_cents ?? 0),
      decision: input.approve ? "approved" : "rejected",
    }).catch(() => undefined);
  }
  let settled: ApprovedInvoiceOutcome | undefined;
  if (input.approve) {
    try {
      // What the manager approved is what the service costs; Approve + pay reads it, never the earlier agreed price.
      await setServiceVendorCost(db, run, approvedAmountCents, now.toISOString());
      const contacts = run.accepted_vendor_directory_id
        ? await loadVendorContacts(db, run.owner_user_id, [run.accepted_vendor_directory_id]).catch(() => null)
        : null;
      const contact = run.accepted_vendor_directory_id ? contacts?.get(run.accepted_vendor_directory_id) : undefined;
      settled = await applyApprovedDispatchInvoice(db, {
        run,
        amountCents: approvedAmountCents,
        invoiceId,
        vendorUserId: invoiceVendorUserId ?? contact?.vendorUserId ?? null,
        vendorDirectoryId: run.accepted_vendor_directory_id,
        vendorName: contact?.name ?? "Vendor",
        now,
      });
      if (settled === "posted" && !invoiceVendorUserId && !contact?.vendorUserId && run.accepted_vendor_directory_id) {
        const { textUnclaimedDirectoryBalance } = await import("@/lib/managed-finance/directory-vendor.server");
        await textUnclaimedDirectoryBalance(db, { directoryId: run.accepted_vendor_directory_id, workspaceId: run.workspace_id, now });
      }
    } catch (error) {
      // The claim must not outlive a failed post, or the manager's next Y finds nothing to approve and the bill is
      // never created. Give the claim back - the ledger post is idempotent on its own source key, so a retry is safe.
      await restoreInvoiceClaim();
      console.error("vendor dispatch invoice not posted", error instanceof Error ? error.message : "unknown");
      return { ok: false, reason: "unavailable" };
    }
  }
  await db
    .from("vendor_dispatch_runs")
    .update({
      pending_invoice_cents: null,
      ...(input.approve ? { agreed_cents: approvedAmountCents } : {}),
      updated_at: now.toISOString(),
    })
    .eq("id", run.id);
  await recordDispatchEvent(db, {
    ownerUserId: run.owner_user_id,
    runId: run.id,
    handle: run.handle,
    event: input.approve ? "invoice_approved" : "invoice_rejected",
    actorUserId: input.actorUserId,
    channel: "sms",
    reply: input.rawText ?? null,
    detail: { amountCents: approvedAmountCents, invoiceId, ...(settled ? { settled } : {}) },
    now,
  });
  return { ok: true, ...(settled ? { settled } : {}) };
}

/** Attempts of a run, for the portal. */
export async function listRunAttempts(db: SupabaseClient, runId: string) {
  return loadAttempts(db, runId);
}
