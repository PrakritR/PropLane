"use client";

/**
 * Quick add, the write. One resident goes through the SAME commit the Add resident wizard uses (the occupancy row
 * with its room-capacity arbitration, the lease filing, the rent schedule + deposit + move-in fee through the
 * household-charge ledger), then the three things the wizard has no door for: private/shared documents in the
 * Documents module, one-time charges (idempotent ids), and the two onboarding links.
 *
 * Order, and what survives what: the row is first; if it is refused (room full, house not yours) NOTHING else runs.
 * Every later step reports on its own and never undoes an earlier one.
 */
import { commitResident, type CommitContext } from "@/components/portal/resident-wizard/commit";
import { buildManualResidentRow, emptyAddPersonForm, type AddPersonForm } from "@/components/portal/resident-wizard/state";
import { createChargesForResidents } from "@/lib/manager-charge-batch";
import { quickAddFormPatch, type QuickAddLeaseChoice, type QuickAddResident } from "./model";

export type QuickAddDocumentKind = "id_private" | "other_private" | "shared";
export const QUICK_ADD_DOCUMENT_KINDS: { value: QuickAddDocumentKind; label: string }[] = [
  { value: "id_private", label: "ID, only you" },
  { value: "other_private", label: "Other, only you" },
  { value: "shared", label: "Shared with the resident" },
];

export type QuickAddFile = { id: string; file: File; kind: QuickAddDocumentKind };

export type QuickAddLease = { choice: QuickAddLeaseChoice; file: File | null; dataUrl: string };

export type QuickAddSaveResult = {
  ok: boolean;
  applicationId: string | null;
  /** Stage -> why; present only for what failed. Never silent. */
  problems: string[];
  emailed: boolean;
  texted: boolean;
};

export type QuickAddSaveContext = Pick<CommitContext, "userId" | "executedLeaseKeys" | "propertyLabelFor"> & {
  /** "Send the generated lease for signature" (only for a resident with no lease PDF attached). */
  sendGeneratedLease: boolean;
};

function randomSuffix(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => "0123456789ABCDEFGHJKLMNPQRSTUVWXYZ"[b % 34]).join("");
}

export function slugForChargeId(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "charge";
}

async function postJson(url: string, body: unknown): Promise<{ ok: boolean; error?: string; data: Record<string, unknown> }> {
  try {
    const res = await fetch(url, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok && data.ok !== false, error: typeof data.error === "string" ? data.error : undefined, data };
  } catch {
    return { ok: false, error: "Network error.", data: {} };
  }
}

async function uploadDocument(entry: QuickAddFile, resident: QuickAddResident): Promise<string | null> {
  const body = new FormData();
  body.set("file", entry.file);
  body.set("category", "other");
  body.set("displayName", `${entry.kind === "id_private" ? "ID" : entry.file.name.replace(/\.[^.]+$/, "")} - ${resident.name}`.slice(0, 120));
  body.set("propertyId", resident.propertyId);
  body.set("residentEmail", resident.email);
  body.set("visibility", entry.kind === "shared" ? "resident" : "manager");
  try {
    const res = await fetch("/api/manager-documents", { method: "POST", credentials: "include", body });
    if (res.ok) return null;
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return `${entry.file.name}: ${data.error ?? "could not be saved"}`;
  } catch {
    return `${entry.file.name}: could not be saved`;
  }
}

export async function saveQuickAddResident(
  resident: QuickAddResident,
  extras: { lease: QuickAddLease; files: readonly QuickAddFile[] },
  ctx: QuickAddSaveContext,
): Promise<QuickAddSaveResult> {
  const problems: string[] = [];
  const form: AddPersonForm = { ...emptyAddPersonForm("resident"), ...(quickAddFormPatch(resident, extras.lease) as Partial<AddPersonForm>) };
  const built = buildManualResidentRow(form, { userId: ctx.userId, propertyLabelFor: ctx.propertyLabelFor, idSuffix: randomSuffix });
  if (!built.ok) return { ok: false, applicationId: null, problems: [built.error], emailed: false, texted: false };

  // The welcome goes out below, one email and one text, so the commit itself stays quiet.
  const sendLease = extras.lease.choice === "draft" || (extras.lease.choice === "none" && ctx.sendGeneratedLease);
  const outcome = await commitResident(built.row, form, { userId: ctx.userId, executedLeaseKeys: ctx.executedLeaseKeys, propertyLabelFor: ctx.propertyLabelFor, assignee: null }, { sendWelcomeEmail: false, sendLease });
  if (outcome.failures.row) return { ok: false, applicationId: null, problems: [outcome.failures.row], emailed: false, texted: false };
  for (const [stage, message] of Object.entries(outcome.failures)) if (message) problems.push(`${stage === "lease" ? "Lease" : stage === "charges" ? "Payments" : "Setup"}: ${message}`);
  const applicationId = outcome.row.id;

  // One-time charges: ids derived from the resident and the charge, so a retry upserts the same row.
  if (resident.oneTimeCharges.length > 0) {
    for (const charge of resident.oneTimeCharges) {
      const { created } = createChargesForResidents(
        [{ applicationId, residentName: resident.name, residentEmail: resident.email, propertyId: resident.propertyId, propertyLabel: ctx.propertyLabelFor(resident.propertyId) ?? "", title: charge.label }],
        {
          managerUserId: ctx.userId,
          amount: charge.amount,
          dueDateLabel: resident.moveInDate,
          initialStatus: "pending",
          baseId: `hc_qa_${applicationId}_${slugForChargeId(charge.label)}`,
        },
      );
      if (created.length === 0) problems.push(`${charge.label}: the charge could not be added`);
    }
  }

  for (const entry of extras.files) {
    const failed = await uploadDocument(entry, resident);
    if (failed) problems.push(failed);
  }

  const email = await postJson("/api/portal/onboard-existing-resident", { applicationId, sendWelcomeEmail: true, viaEmail: true, viaSms: false, viaInbox: true });
  const emailSent = email.ok && email.data.welcomeEmailSent === true;
  if (!emailSent) {
    const why = email.error ?? (email.data.communicationBlocked ? "this plan has no Communication yet" : typeof email.data.welcomeError === "string" ? email.data.welcomeError : "not sent");
    problems.push(`Email link: ${why}`);
  }
  const text = await postJson("/api/portal/resident-onboarding-link", { applicationId });
  if (!text.ok) problems.push(`Text link: ${text.error ?? "not sent"}`);

  return { ok: problems.length === 0, applicationId, problems, emailed: emailSent, texted: text.ok };
}
