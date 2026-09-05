import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { residentSmsLinkOrigin } from "@/lib/claw-resident-links";
import { deliverPortalInboxMessage } from "@/lib/portal-inbox-delivery";
import {
  normalizeLeasePipelineRow,
  type LeasePipelineRow,
  type LeaseThreadMessage,
  type LeaseThreadRole,
} from "@/lib/lease-pipeline-storage";
import { formatPacificDateTime } from "@/lib/pacific-time";
import { orFilterForIdentity } from "@/lib/supabase/or-filter";

const MAX_ISSUE_LENGTH = 4000;

function asObject(v: unknown): Record<string, unknown> | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  return v as Record<string, unknown>;
}

// `LeaseThreadRole` is manager | admin | resident — a thread message has no
// "system" role to store. Typed to the real union so a call that tried to write
// one fails here rather than producing a row the reader cannot classify.
function threadMessage(role: LeaseThreadRole, body: string): LeaseThreadMessage {
  return {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
    at: new Date().toISOString(),
    role,
    body: body.trim(),
  };
}

function leaseReviewPath(): string {
  return `${residentSmsLinkOrigin()}/portal/leases/manager`;
}

async function propertyLabelForLease(
  db: SupabaseClient,
  leaseRecord: { property_id?: string | null; row_data: unknown },
  leaseRow: LeasePipelineRow,
): Promise<string | undefined> {
  const propertyId = leaseRecord.property_id ?? leaseRow.propertyId ?? leaseRow.application?.propertyId ?? "";
  if (!propertyId) return leaseRow.unit?.trim() || undefined;
  const { data } = await db
    .from("manager_property_records")
    .select("row_data")
    .eq("id", propertyId)
    .maybeSingle();
  const rowData = asObject(data?.row_data);
  const title = typeof rowData?.title === "string" ? rowData.title.trim() : "";
  return title || leaseRow.unit?.trim() || undefined;
}

/**
 * A resident may only push a lease back while it is genuinely waiting on THEIR
 * signature and they have not already signed it.
 *
 * Pinning `status` to "Resident Signature Pending" already excludes "Fully
 * Signed" and "Voided" — the two extra comparisons that used to sit here could
 * never be false, which is what the compiler was reporting. Removing them
 * changes nothing this function accepts.
 */
export function residentLeaseIssueAllowed(row: LeasePipelineRow): boolean {
  return (
    row.bucket === "resident" &&
    row.status === "Resident Signature Pending" &&
    !row.residentSignature
  );
}

function residentOwnsLeaseRecord(
  record: { resident_user_id?: string | null; resident_email?: string | null },
  residentUserId: string,
  email: string,
): boolean {
  const storedUserId = String(record.resident_user_id ?? "").trim();
  const storedEmail = String(record.resident_email ?? "").trim().toLowerCase();
  if (storedUserId) return storedUserId === residentUserId;
  return storedEmail === email;
}

export async function reportResidentLeaseIssue(
  db: SupabaseClient,
  input: {
    residentUserId: string;
    residentEmail: string;
    residentName?: string;
    leaseId: string;
    message: string;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const email = input.residentEmail.trim().toLowerCase();
  const issue = input.message.trim();
  if (!email) return { ok: false, error: "No email on file." };
  if (!issue) return { ok: false, error: "Describe what needs to change." };
  if (issue.length > MAX_ISSUE_LENGTH) {
    return { ok: false, error: `Keep your note under ${MAX_ISSUE_LENGTH} characters.` };
  }

  const leaseId = input.leaseId.trim();
  if (!leaseId) return { ok: false, error: "Lease not found." };

  const identityFilter = orFilterForIdentity([
    ["resident_user_id", input.residentUserId],
    ["resident_email", email],
  ]);
  if (!identityFilter) return { ok: false, error: "No email on file." };

  const { data: leaseRecord, error } = await db
    .from("portal_lease_pipeline_records")
    .select("id, row_data, manager_user_id, property_id, resident_email, resident_user_id")
    .eq("id", leaseId)
    .or(identityFilter)
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!leaseRecord || !residentOwnsLeaseRecord(leaseRecord, input.residentUserId, email)) {
    return { ok: false, error: "Lease not found." };
  }

  const previousRow = normalizeLeasePipelineRow(leaseRecord.row_data);
  if (!residentLeaseIssueAllowed(previousRow)) {
    return { ok: false, error: "This lease is not open for resident signature." };
  }

  const iso = new Date().toISOString();
  const thread = [
    ...(previousRow.thread ?? []),
    threadMessage("resident", `Resident reported an issue:\n${issue}`),
  ];
  const updatedRow = normalizeLeasePipelineRow({
    ...previousRow,
    bucket: "manager",
    status: "Manager Review",
    currentActorRole: "manager",
    thread,
    updatedAtIso: iso,
    updated: formatPacificDateTime(iso),
  });

  const { error: updateError } = await db
    .from("portal_lease_pipeline_records")
    .update({
      row_data: updatedRow,
      status: updatedRow.bucket,
      updated_at: iso,
    })
    .eq("id", leaseId)
    .or(identityFilter);

  if (updateError) return { ok: false, error: updateError.message };

  const managerUserId = String(leaseRecord.manager_user_id ?? updatedRow.managerUserId ?? "").trim();
  if (managerUserId) {
    const residentName = input.residentName?.trim() || updatedRow.residentName?.trim() || "Resident";
    const property = await propertyLabelForLease(db, leaseRecord, updatedRow);
    const unit = updatedRow.unit?.trim();
    const propertyLabel = property || unit || "assigned property";
    const subject = `Lease issue reported · ${propertyLabel}`;
    const text = [
      `${residentName} reported an issue with the lease and sent it back for review.`,
      "",
      `Resident: ${residentName}`,
      `Resident email: ${email}`,
      `Property: ${propertyLabel}`,
      unit ? `Unit: ${unit}` : null,
      "",
      "Issue:",
      issue,
      "",
      "The lease is back in Manager Review. Update the document and send it again when ready.",
      "",
      `Review: ${leaseReviewPath()}`,
    ]
      .filter(Boolean)
      .join("\n");

    const smsText = [
      "(Lease issue reported)",
      `${residentName} · ${propertyLabel}`,
      issue.length > 120 ? `${issue.slice(0, 117)}…` : issue,
      `Review: ${leaseReviewPath()}`,
    ].join("\n");

    await deliverPortalInboxMessage(db, {
      senderUserId: input.residentUserId,
      senderEmail: email,
      fromName: residentName,
      subject,
      text,
      toUserIds: [managerUserId],
      eventCategory: "leases",
      smsText,
      messageId: `${leaseId}:lease_issue_reported:${iso}`,
    }).catch(() => undefined);
  }

  return { ok: true };
}
