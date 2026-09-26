import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeLeasePipelineRow, type LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import { managerOutboundFromHeader } from "@/lib/manager-outbound-identity.server";
import { postResendEmail } from "@/lib/resend-delivery.server";
import { rateLimit } from "@/lib/rate-limit";
import { orFilterForIdentity } from "@/lib/supabase/or-filter";

/**
 * C278 — the optional representative / legal representative / guarantor
 * fields on the "Sign" step of the Ida Cares lease-first wizard become
 * invite-by-email: the resident types the third party's email, this sends
 * them a plain notice, and the resident's own typed answer (their email)
 * still saves through the wizard's existing `signingAnswers` write — no new
 * table, no new account, no new auth surface. The invite is informational
 * only: the third party is never given portal access or a way to sign.
 *
 * Integrator review hardening: a signed-in resident could otherwise send a
 * from-PropLane email to any address with an arbitrary "role" and their own
 * chosen display name in the subject/body, unthrottled — a spam/phishing
 * vector. Three fixed rules close it: the role is classified against a fixed
 * allowlist (never the caller's raw string), the resident's name comes only
 * from the lease row PropLane already trusts (never `profiles.full_name`,
 * which the resident controls) and is sanitized before it reaches an email,
 * and both a per-resident and a per-(lease, role) rate limit apply.
 */

const EMAIL_RE = /^[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+$/;
const MAX_CLASSIFY_INPUT_LENGTH = 200;
const MAX_RESIDENT_NAME_LENGTH = 100;

const DAY_MS = 24 * 60 * 60 * 1000;
/** 5 invites/resident/24h — generous for three optional fields on one lease, tight for abuse. */
const PER_RESIDENT_LIMIT = 5;
/** One invite per (lease, role)/24h — a resent invite is a retry, not a new send. */
const PER_LEASE_ROLE_LIMIT = 1;

export type SignerInviteRoleId = "representative" | "legal_representative" | "guarantor";
export type SignerInviteRole = { id: SignerInviteRoleId; label: string };

/**
 * The wizard's own field definitions name exactly three optional signers
 * (`scripts/seed-ida-cares-dev.ts`'s `la_sig_representative` /
 * `la_sig_legal_representative` / `la_sig_guarantor`, and any future imported
 * template's equivalent clauses). Matching by normalized label text, most
 * specific pattern first, keeps this working for both the seed fixture and a
 * real imported document without hard-coding the seed's exact field ids —
 * but ANYTHING that fails to match is refused rather than guessed at, so a
 * rogue or unexpected field can never reach the outgoing email as a "role".
 */
const SIGNER_INVITE_ROLES: readonly { id: SignerInviteRoleId; label: string; match: RegExp }[] = [
  { id: "guarantor", label: "Guarantor", match: /personal guarantee|guarantor/i },
  { id: "legal_representative", label: "Legal representative", match: /legal representative/i },
  { id: "representative", label: "Representative", match: /representative/i },
];

export function classifySignerInviteRole(rawLabel: string): SignerInviteRole | null {
  const normalized = rawLabel.trim().slice(0, MAX_CLASSIFY_INPUT_LENGTH);
  if (!normalized) return null;
  for (const role of SIGNER_INVITE_ROLES) {
    if (role.match.test(normalized)) return { id: role.id, label: role.label };
  }
  return null;
}

/** Strips anything that could turn a name into a link or reformat the email around it. */
function sanitizeResidentNameForEmail(raw: string): string {
  const stripped = raw
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/www\.\S+/gi, "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return stripped.slice(0, MAX_RESIDENT_NAME_LENGTH) || "Your resident";
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
    leaseId: string;
    /** Raw field label from the wizard — classified against the fixed allowlist below, never used verbatim. */
    roleLabel: string;
    inviteEmail: string;
  },
): Promise<{ ok: true } | { ok: false; error: string; status?: number }> {
  const email = input.residentEmail.trim().toLowerCase();
  if (!email) return { ok: false, error: "No email on file." };

  const leaseId = input.leaseId.trim();
  if (!leaseId) return { ok: false, error: "Lease not found." };

  const role = classifySignerInviteRole(input.roleLabel);
  if (!role) return { ok: false, error: "This field cannot be invited by email." };

  const inviteEmail = input.inviteEmail.trim().toLowerCase();
  if (!inviteEmail || !EMAIL_RE.test(inviteEmail)) {
    return { ok: false, error: "Enter a valid email to invite." };
  }

  const residentLimit = await rateLimit(`lease-signer-invite:user:${input.residentUserId}`, PER_RESIDENT_LIMIT, DAY_MS);
  if (residentLimit.unavailable) return { ok: false, error: "Invites are temporarily unavailable. Try again shortly.", status: 503 };
  if (!residentLimit.ok) {
    return { ok: false, error: "You can send at most 5 invites in 24 hours. Try again later.", status: 429 };
  }

  const leaseRoleLimit = await rateLimit(`lease-signer-invite:lease-role:${leaseId}:${role.id}`, PER_LEASE_ROLE_LIMIT, DAY_MS);
  if (leaseRoleLimit.unavailable) return { ok: false, error: "Invites are temporarily unavailable. Try again shortly.", status: 503 };
  if (!leaseRoleLimit.ok) {
    return { ok: false, error: `An invite for ${role.label.toLowerCase()} on this lease was already sent in the last 24 hours.`, status: 429 };
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

  // The lease row is PropLane's own trusted record of who this resident is — never
  // `profiles.full_name`, which the resident can set to anything (including a link).
  const residentName = sanitizeResidentNameForEmail(leaseRow.residentName?.trim() || "Your resident");
  const propertyLabel = leaseRow.unit?.trim() || "";
  const managerUserId = String(leaseRecord.manager_user_id ?? leaseRow.managerUserId ?? "").trim();
  const from = await managerOutboundFromHeader(db, managerUserId || null);
  const subject = `${residentName} named you as ${role.label} on a PropLane lease`;
  const text = inviteEmailBody({ residentName, roleLabel: role.label, propertyLabel });

  const res = await postResendEmail({
    apiKey,
    actorUserId: input.residentUserId,
    payload: { from, to: [inviteEmail], subject, text },
    effectSummary: "Lease-first signer invite email captured for the test workspace.",
    metadata: { leaseId, role: role.id },
  });
  if (!res.ok) {
    const payload = (await res.json().catch(() => ({}))) as { message?: string };
    return { ok: false, error: payload.message ?? "Could not send the invite." };
  }
  return { ok: true };
}
