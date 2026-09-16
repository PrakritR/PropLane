"use client";

/**
 * The ordered write behind "Add resident" / "Add prospect".
 *
 *   row → lease filing → charges + payment marks → documents → tour → message
 *
 * Each stage reports; a later failure never undoes an earlier one — the row
 * exists, and the outcome names what still needs attaching. Every stage is
 * safe to run again for the same row.
 */

import type { DemoApplicantRow } from "@/data/demo-portal";
import type { ApplicationPhotoAttachment, ApplicationPhotoSlot } from "@/lib/rental-application/types";
import {
  appendManagerApplicationRow,
  normalizeApplicationAxisId,
  readManagerApplicationRows,
  replaceManagerApplicationRowInCache,
  syncManagerApplicationsFromServer,
  upsertApplicationRowToServerAwait,
  writeManagerApplicationRows,
} from "@/lib/manager-applications-storage";
import {
  markImportedTenancyCharges,
  mirrorHouseholdChargesToServerAwait,
  recordApprovedApplicationCharges,
  syncHouseholdChargesFromServer,
  trimImportedTenancyBillingStart,
  type ImportedTenancyMarks,
} from "@/lib/household-charges";
import {
  ensureManagerReviewLeaseForApplication,
  syncLeasePipelineFromApplications,
  syncLeasePipelineFromServer,
} from "@/lib/lease-pipeline-storage";
import { uploadAndParseLeasePdf } from "@/lib/uploaded-lease-parse.client";
import { uploadApplicationPhoto } from "@/components/marketing/application-photo-field";
import { createManualPlannedTourClient } from "@/lib/manual-planned-tour.client";
import { createScheduledWorkTask, scheduledTaskTitleForTour } from "@/lib/manager-scheduled-work-tasks";
import { compactTaskPropertyLabel } from "@/lib/manager-task-display";
import { getPropertyById } from "@/lib/rental-application/data";
import type { WorkAssignee } from "@/lib/work-assignment";
import { deliverPortalInboxMessage } from "@/lib/portal-message-delivery";
import type { AttachedDocument } from "@/components/portal/add-workspace/parts";
import { paymentSchedulePreview, type AddPersonForm } from "./state";

export type CommitStage = "row" | "lease" | "charges" | "documents" | "tour" | "message";
export type CommitOutcome = {
  ok: boolean;
  row: DemoApplicantRow;
  /** Stage → what went wrong, for the ones that did. */
  failures: Partial<Record<CommitStage, string>>;
  notes: string[];
  tourId?: string | null;
};

export type CommitContext = {
  userId: string | null;
  executedLeaseKeys: { axisIds: Set<string>; emails: Set<string> };
  propertyLabelFor: (propertyId: string) => string | undefined;
  assignee: WorkAssignee | null;
};

function slotForDocument(doc: AttachedDocument): { slot: ApplicationPhotoSlot; fieldKey?: string } | null {
  switch (doc.kind) {
    case "id_front":
      return { slot: "idFront" };
    case "id_back":
      return { slot: "idBack" };
    case "income_proof":
      return { slot: "income" };
    case "application":
      return { slot: "custom", fieldKey: "source-application" };
    case "other":
      return { slot: "custom", fieldKey: "other-document" };
    default:
      // The lease PDF is filed through the lease pipeline, not the photo slots.
      return null;
  }
}

function dropRowFromCache(id: string) {
  writeManagerApplicationRows(readManagerApplicationRows().filter((r) => r.id !== id), { serverConfirmed: true });
}

function combineLocalDateTime(date: string, time: string): string {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0, 0, 0).toISOString();
}

export async function commitResident(row: DemoApplicantRow, form: AddPersonForm, ctx: CommitContext): Promise<CommitOutcome> {
  const failures: CommitOutcome["failures"] = {};
  const notes: string[] = [];

  // 1. The row. A refused write (room full, property not yours…) leaves no
  //    phantom in the local list — the wizard stays open with the reason.
  appendManagerApplicationRow(row, { skipServerMirror: true });
  const persisted = await upsertApplicationRowToServerAwait(row, { existingResidentOnboarding: { sendWelcomeEmail: false } });
  if (!persisted.ok) {
    dropRowFromCache(row.id);
    return { ok: false, row, failures: { row: persisted.error ?? "Could not save the resident." }, notes };
  }

  // 2. Charges from the tenancy — the same generator approval runs — then the
  //    manager's payment marks on top of them, then one awaited mirror so the
  //    server holds the charges and the recurring profile BEFORE anything
  //    re-syncs from it (a force sync racing a fire-and-forget mirror wiped
  //    the profile). Then the lease filing.
  if (row.bucket === "approved") {
    recordApprovedApplicationCharges(row, ctx.userId, true, {
      leaseExecuted:
        row.manuallyAdded === true ||
        ctx.executedLeaseKeys.axisIds.has(normalizeApplicationAxisId(row.id)) ||
        Boolean(row.email?.trim() && ctx.executedLeaseKeys.emails.has(row.email.trim().toLowerCase())),
    });
    if (row.email && form.propertyId) {
      try {
        if (form.billingStart === "next_due") {
          const today = new Date();
          const next = new Date(today.getFullYear(), today.getMonth() + 1, 1);
          const firstBilledMonth = `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
          trimImportedTenancyBillingStart({ residentEmail: row.email, propertyId: form.propertyId, managerUserId: ctx.userId, firstBilledMonth });
        } else {
          const rows = paymentSchedulePreview(form);
          const months: ImportedTenancyMarks["months"] = {};
          for (const r of rows) {
            const mark = form.paymentMarks[r.monthKey] ?? { status: r.isCurrent ? "due" : "paid", paidOn: r.dueOn, method: "zelle" };
            months[r.monthKey] = {
              status: mark.status,
              paidOn: mark.paidOn,
              method: mark.method,
              partialAmount: mark.partialAmount ? Number(mark.partialAmount.replace(/[^\d.]/g, "")) : undefined,
            };
          }
          const oneTimePaidOn = form.oneTimePaidOn || form.moveInDate;
          const marks: ImportedTenancyMarks = {
            residentEmail: row.email,
            propertyId: form.propertyId,
            applicationId: row.id,
            moveInMonth: form.moveInDate.slice(0, 7),
            months,
            oneTime: {
              securityDeposit: { status: form.depositPaid ? "paid" : "due", paidOn: oneTimePaidOn, method: form.oneTimeMethod },
              moveInFee: { status: form.moveInFeePaid ? "paid" : "due", paidOn: oneTimePaidOn, method: form.oneTimeMethod },
            },
          };
          const result = markImportedTenancyCharges(marks);
          if (result.updated) notes.push(`${result.updated} ${result.updated === 1 ? "payment" : "payments"} recorded`);
        }
      } catch (err) {
        failures.charges = err instanceof Error ? err.message : "Payments could not be recorded.";
      }
    }
    const mirrored = await mirrorHouseholdChargesToServerAwait();
    if (!mirrored && !failures.charges) failures.charges = "The payment schedule could not be saved — open Payments to check it.";
  }
  syncLeasePipelineFromApplications(ctx.userId);

  if (form.leaseDocument === "draft" && form.leaseFile) {
    const ensured = ensureManagerReviewLeaseForApplication(row.id, ctx.userId);
    if (!ensured.ok) failures.lease = ensured.error ?? "The draft lease could not be filed.";
    else {
      const uploaded = await uploadAndParseLeasePdf(ensured.row.id, form.leaseFile, ctx.userId);
      if (!uploaded.ok) failures.lease = uploaded.error ?? "The draft lease PDF could not be filed.";
    }
  }

  await Promise.all([
    syncManagerApplicationsFromServer({ force: true, managerUserId: ctx.userId }),
    syncLeasePipelineFromServer(ctx.userId, { force: true }),
    syncHouseholdChargesFromServer(true),
  ]);

  // 4. Documents — after the row exists, since the photo route needs its id.
  const attachments = await uploadDocuments(row, form.documents, failures);
  if (attachments.changed) {
    const updated: DemoApplicantRow = {
      ...row,
      application: { ...(row.application ?? {}), ...attachments.applicationPatch } as DemoApplicantRow["application"],
      manualResidentDetails: {
        ...row.manualResidentDetails,
        ...(attachments.other.length ? { documents: attachments.other } : {}),
      },
    };
    replaceManagerApplicationRowInCache(updated);
    const saved = await upsertApplicationRowToServerAwait(updated, { existingResidentOnboarding: { sendWelcomeEmail: false } });
    if (!saved.ok) failures.documents = saved.error ?? "Documents were uploaded but could not be linked to the resident.";
  }

  return { ok: Object.keys(failures).length === 0, row, failures, notes };
}

export async function commitProspect(built: DemoApplicantRow, form: AddPersonForm, ctx: CommitContext): Promise<CommitOutcome> {
  const failures: CommitOutcome["failures"] = {};
  const notes: string[] = [];
  // Same email already in Residents (a prospect who asked twice, an applicant
  // who then booked a tour): link the tour to them instead of a second row.
  const email = built.email?.trim().toLowerCase();
  const existing = email ? readManagerApplicationRows().find((r) => r.email?.trim().toLowerCase() === email) : undefined;
  let row = built;
  if (existing) {
    row = existing;
    notes.push(`linked to ${existing.name}'s existing record`);
  } else {
    appendManagerApplicationRow(row, { skipServerMirror: true });
    const persisted = await upsertApplicationRowToServerAwait(row);
    if (!persisted.ok) {
      dropRowFromCache(row.id);
      return { ok: false, row, failures: { row: persisted.error ?? "Could not save the prospect." }, notes };
    }
    await syncManagerApplicationsFromServer({ force: true, managerUserId: ctx.userId });
  }

  let tourId: string | null = null;
  if (form.tourFormat !== "none" && form.tourDate && form.tourStart && ctx.userId) {
    const start = combineLocalDateTime(form.tourDate, form.tourStart);
    const durationMs = Math.max(15, Number(form.tourDurationMinutes) || 30) * 60 * 1000;
    const end = new Date(Date.parse(start) + durationMs).toISOString();
    const label = form.propertyId ? ctx.propertyLabelFor(form.propertyId) : undefined;
    const roomLabel = row.manualResidentDetails?.roomNumber ?? built.manualResidentDetails?.roomNumber;
    if (!form.propertyId) {
      failures.tour = "Pick a property to put the tour on the calendar.";
    } else {
      const result = await createManualPlannedTourClient(ctx.userId, {
        propertyId: form.propertyId,
        propertyTitle: compactTaskPropertyLabel(form.propertyId, label) ?? label,
        roomLabel,
        guestName: form.name.trim(),
        guestEmail: form.email.trim() || undefined,
        guestPhone: form.phone.trim() || undefined,
        start,
        end,
        notes: form.tourNotes.trim() || undefined,
        tourFormat: form.tourFormat,
        assignee: ctx.assignee,
      });
      if (!result.ok) failures.tour = result.error;
      else {
        tourId = result.plannedEvent?.id ? String(result.plannedEvent.id) : null;
        if (ctx.assignee) {
          void createScheduledWorkTask(ctx.userId, {
            title: scheduledTaskTitleForTour(form.name.trim()),
            start,
            end,
            propertyId: form.propertyId,
            propertyTitle: label,
            roomLabel,
            assignee: ctx.assignee,
            taskType: "tour",
            linkedTourId: tourId ?? "",
            notes: form.email.trim() ? `Guest: ${form.email.trim()}` : undefined,
          });
        }
        if (tourId) {
          const updated: DemoApplicantRow = {
            ...row,
            manualResidentDetails: { ...row.manualResidentDetails, prospect: { ...row.manualResidentDetails?.prospect, tourId } },
          };
          replaceManagerApplicationRowInCache(updated);
          void upsertApplicationRowToServerAwait(updated);
        }
      }
    }
  }
  return { ok: Object.keys(failures).length === 0, row, failures, notes, tourId };
}

/** Add application: a pending in-progress draft the applicant finishes through their secure link. */
export async function commitApplicationDraft(row: DemoApplicantRow, form: AddPersonForm, ctx: CommitContext): Promise<CommitOutcome> {
  const failures: CommitOutcome["failures"] = {};
  const notes: string[] = [];
  appendManagerApplicationRow(row, { skipServerMirror: true });
  const persisted = await upsertApplicationRowToServerAwait(row);
  if (!persisted.ok) {
    dropRowFromCache(row.id);
    return { ok: false, row, failures: { row: persisted.error ?? "Could not save the application." }, notes };
  }
  await syncManagerApplicationsFromServer({ force: true, managerUserId: ctx.userId });
  const attachments = await uploadDocuments(row, form.documents, failures);
  if (attachments.changed) {
    const updated: DemoApplicantRow = {
      ...row,
      application: { ...(row.application ?? {}), ...attachments.applicationPatch } as DemoApplicantRow["application"],
      manualResidentDetails: { ...row.manualResidentDetails, ...(attachments.other.length ? { documents: attachments.other } : {}) },
    };
    replaceManagerApplicationRowInCache(updated);
    const saved = await upsertApplicationRowToServerAwait(updated);
    if (!saved.ok) failures.documents = saved.error ?? "Documents were uploaded but could not be linked to the application.";
  }
  return { ok: Object.keys(failures).length === 0, row, failures, notes };
}

/**
 * The "review & sign" email for a manager-started application — composed by
 * the server because it carries the applicant's secure resume link. `preview`
 * returns the text so the same words can go by SMS.
 */
export async function sendApplicationStartedEmail(applicationId: string, opts: { preview?: boolean } = {}): Promise<{ ok: boolean; error?: string; preview?: { to?: string; subject?: string; text?: string }; skipped?: boolean }> {
  const res = await fetch("/api/portal/send-manager-application-started", {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ applicationId, preview: opts.preview === true }),
  });
  const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string; preview?: { to?: string; subject?: string; text?: string }; skipped?: boolean };
  if (!res.ok || data.ok === false) return { ok: false, error: data.error ?? "Could not send the application email." };
  return { ok: true, preview: data.preview, skipped: data.skipped };
}

async function uploadDocuments(
  row: DemoApplicantRow,
  documents: AttachedDocument[],
  failures: CommitOutcome["failures"],
): Promise<{ changed: boolean; applicationPatch: Record<string, unknown>; other: (ApplicationPhotoAttachment & { kind: string })[] }> {
  const applicationPatch: Record<string, unknown> = {};
  const income: ApplicationPhotoAttachment[] = [];
  const other: (ApplicationPhotoAttachment & { kind: string })[] = [];
  let changed = false;
  const problems: string[] = [];
  for (const doc of documents) {
    const target = slotForDocument(doc);
    if (!target) continue;
    const result = await uploadApplicationPhoto({ applicationId: row.id, slot: target.slot, file: doc.file, fieldKey: target.fieldKey ?? null });
    if (!result.ok) {
      problems.push(`${doc.file.name}: ${result.error}`);
      continue;
    }
    changed = true;
    if (target.slot === "idFront") applicationPatch.idPhotoFront = result.attachment;
    else if (target.slot === "idBack") applicationPatch.idPhotoBack = result.attachment;
    else if (target.slot === "income") income.push(result.attachment);
    else other.push({ ...result.attachment, kind: doc.kind });
  }
  if (income.length) applicationPatch.incomeProofPhotos = income;
  if (problems.length) failures.documents = problems.join(" · ");
  return { changed, applicationPatch, other };
}

/** Send the closing message the way the Review step asked. */
export async function sendClosingMessage(input: {
  toEmail: string;
  viaEmail: boolean;
  viaSms: boolean;
  subject: string;
  body: string;
  scheduleAt?: string;
  recipientName: string;
}): Promise<{ ok: boolean; message: string }> {
  const to = input.toEmail.trim().toLowerCase();
  if (input.scheduleAt) {
    const response = await fetch("/api/portal/scheduled-inbox-messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({
        subject: input.subject,
        body: input.body,
        sendAt: input.scheduleAt,
        deliverViaEmail: input.viaEmail,
        deliverViaSms: input.viaSms,
        recipientEmail: to,
        recipientName: input.recipientName,
        senderPortal: "manager",
      }),
    });
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    return response.ok ? { ok: true, message: `Notice scheduled for ${to}.` } : { ok: false, message: data.error ?? "The notice could not be scheduled." };
  }
  const notice = await deliverPortalInboxMessage({
    eventCategory: "messages",
    toEmails: to.includes("@") ? [to] : [],
    subject: input.subject,
    text: input.body,
    deliverViaEmail: input.viaEmail && to.includes("@"),
    deliverViaSms: input.viaSms,
  });
  if (notice.ok) return { ok: true, message: notice.skipped ? `Notice saved to the PropLane inbox for ${input.recipientName}.` : `Notice sent to ${input.recipientName}.` };
  return { ok: false, message: notice.error ? `Notice failed: ${notice.error}` : "The notice could not be sent." };
}
