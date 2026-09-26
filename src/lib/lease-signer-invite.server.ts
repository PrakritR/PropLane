import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeLeasePipelineRow, type LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import { managerOutboundFromHeader } from "@/lib/manager-outbound-identity.server";
import { postResendEmail } from "@/lib/resend-delivery.server";
import { orFilterForIdentity } from "@/lib/supabase/or-filter";

/**
 * C278 — the optional representative / legal representative / guarantor
 * fields on the "Sign" step of the Ida Cares lease-first wizard become
 * invite-by-email: the resident types the third party's email, this sends
 * them a plain notice, and the resident's own typed answer (their email)
 * still saves through the wizard's existing `signingAnswers` write — no new
 * table, no new account, no new auth surface. The invite is informational
 * only: the third party is never given portal access or a way to sign.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
const MAX_LABEL_LENGTH = 200;

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

/** Only the lease-first "Sign" step's own in-progress row may send a signer invite. */
function leaseFirstSignStepOpen(row: LeasePipelineRow): boolean {
  return (
    row.leaseFirst === true &&
    row.bucket === "resident" &&
    row.status === "Resident Signature Pending" &&
    !row.residentSignature
  );
}

function inviteEmailBody(params: { residentName: string; roleLabel: string; propertyLabel: string }): string {
  return [
    `${params.residentName} named you as "${params.roleLabel}" on their PropLane lease${params.propertyLabel ? ` for ${params.propertyLabel}` : ""}.`,
    "",
    "This is an informational notice only — there is nothing for you to sign here, and this email does not create or require a PropLane account.",
    `If you have questions, contact ${params.residentName} directly or reach out to the property manager.`,
    "",
    "— PropLane",
  ].join("\n");
}

export async function sendLeaseSignerInvite(
  db: SupabaseClient,
  input: {
    residentUserId: string;
    residentEmail: string;
    residentName?: string;
    leaseId: string;
    roleLabel: string;
    inviteEmail: string;
  },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const email = input.residentEmail.trim().toLowerCase();
  if (!email) return { ok: false, error: "No email on file." };

  const leaseId = input.leaseId.trim();
  if (!leaseId) return { ok: false, error: "Lease not found." };

  const roleLabel = input.roleLabel.trim().slice(0, MAX_LABEL_LENGTH);
  if (!roleLabel) return { ok: false, error: "This field has no label to invite for." };

  const inviteEmail = input.inviteEmail.trim().toLowerCase();
  if (!inviteEmail || !EMAIL_RE.test(inviteEmail)) {
    return { ok: false, error: "Enter a valid email to invite." };
  }

  const identityFilter = orFilterForIdentity([
    ["resident_user_id", input.residentUserId],
    ["resident_email", email],
  ]);
  if (!identityFilter) return { ok: false, error: "No email on file." };

  const { data: leaseRecord, error } = await db
    .from("portal_lease_pipeline_records")
    .select("id, row_data, manager_user_id, resident_email, resident_user_id")
    .eq("id", leaseId)
    .or(identityFilter)
    .maybeSingle();

  if (error) return { ok: false, error: error.message };
  if (!leaseRecord || !residentOwnsLeaseRecord(leaseRecord, input.residentUserId, email)) {
    return { ok: false, error: "Lease not found." };
  }

  const leaseRow = normalizeLeasePipelineRow(leaseRecord.row_data);
  if (!leaseFirstSignStepOpen(leaseRow)) {
    return { ok: false, error: "This lease is not open for signing right now." };
  }

  const apiKey = process.env.RESEND_API_KEY?.trim();
  if (!apiKey) return { ok: false, error: "Email delivery is not configured." };

  const residentName = input.residentName?.trim() || leaseRow.residentName?.trim() || "Your resident";
  const propertyLabel = leaseRow.unit?.trim() || "";
  const managerUserId = String(leaseRecord.manager_user_id ?? leaseRow.managerUserId ?? "").trim();
  const from = await managerOutboundFromHeader(db, managerUserId || null);
  const subject = `${residentName} named you as ${roleLabel} on a PropLane lease`;
  const text = inviteEmailBody({ residentName, roleLabel, propertyLabel });

  const res = await postResendEmail({
    apiKey,
    actorUserId: input.residentUserId,
    payload: { from, to: [inviteEmail], subject, text },
    effectSummary: "Lease-first signer invite email captured for the test workspace.",
    metadata: { leaseId, roleLabel },
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { message?: string };
    return { ok: false, error: payload.message ?? "Could not send the invite." };
  }
  return { ok: true };
}
