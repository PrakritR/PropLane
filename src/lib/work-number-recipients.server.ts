import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { resolveWorkspaceSendLine } from "@/lib/sms/manager-number-provisioning.server";
import { sendFromManagerWorkNumber } from "@/lib/proplane-sms-transport.server";
import { sendManagerNoticeEmail } from "@/lib/manager-notice-email.server";
import { normalizeE164 } from "@/lib/phone-e164";

/**
 * People who are not PropLane accounts but get every manager notice the workspace's work number
 * sends: a text FROM the owner's work number (billed to the owner) and an email FROM the work
 * email. They never get a PropLane Assistant thread. Service-role only (the table has no client
 * policy).
 */
export type WorkNumberRecipient = {
  id: string;
  ownerUserId: string;
  label: string;
  phone: string | null;
  email: string | null;
  createdAt: string;
};

export const MAX_WORK_NUMBER_RECIPIENTS = 10;

const EMAIL_PATTERN = /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/;

export function parseWorkNumberRecipientInput(raw: { label?: unknown; phone?: unknown; email?: unknown }):
  | { ok: true; label: string; phone: string | null; email: string | null }
  | { ok: false; error: string } {
  const label = typeof raw.label === "string" ? raw.label.trim().slice(0, 80) : "";
  if (!label) return { ok: false, error: "Enter a name." };
  const phoneRaw = typeof raw.phone === "string" ? raw.phone.trim() : "";
  const emailRaw = typeof raw.email === "string" ? raw.email.trim().toLowerCase() : "";
  const phone = phoneRaw ? normalizeE164(phoneRaw) : null;
  if (phoneRaw && !phone) return { ok: false, error: "Enter a valid phone number." };
  if (emailRaw && !EMAIL_PATTERN.test(emailRaw)) return { ok: false, error: "Enter a valid email." };
  if (!phone && !emailRaw) return { ok: false, error: "Add a phone or an email." };
  return { ok: true, label, phone, email: emailRaw || null };
}

function toRecipient(row: Record<string, unknown>): WorkNumberRecipient {
  return {
    id: String(row.id ?? ""),
    ownerUserId: String(row.owner_user_id ?? ""),
    label: String(row.label ?? ""),
    phone: typeof row.phone === "string" && row.phone.trim() ? row.phone.trim() : null,
    email: typeof row.email === "string" && row.email.trim() ? row.email.trim() : null,
    createdAt: String(row.created_at ?? ""),
  };
}

export async function listWorkNumberRecipients(db: SupabaseClient, ownerUserId: string): Promise<WorkNumberRecipient[]> {
  const { data, error } = await db
    .from("workspace_work_number_recipients")
    .select("id, owner_user_id, label, phone, email, created_at")
    .eq("owner_user_id", ownerUserId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(error.message);
  return ((data ?? []) as Record<string, unknown>[]).map(toRecipient);
}

/**
 * Deliver one notice to each extra recipient. Best-effort and idempotent per (key, recipient): a
 * failure for one person never blocks another or the owner's own notice. Never logs an address,
 * number or body.
 */
export async function notifyWorkNumberRecipients(
  db: SupabaseClient,
  input: {
    ownerUserId: string;
    workspaceId?: string | null;
    subject: string;
    text: string;
    url?: string;
    idempotencyKey?: string;
  },
): Promise<{ texted: number; emailed: number }> {
  let recipients: WorkNumberRecipient[] = [];
  try {
    recipients = await listWorkNumberRecipients(db, input.ownerUserId);
  } catch {
    return { texted: 0, emailed: 0 };
  }
  if (recipients.length === 0) return { texted: 0, emailed: 0 };
  const line = recipients.some((r) => r.phone)
    ? await resolveWorkspaceSendLine(db, input.ownerUserId, input.workspaceId ?? null).catch(() => null)
    : null;
  let texted = 0;
  let emailed = 0;
  for (const recipient of recipients) {
    const key = input.idempotencyKey
      ? createHash("sha256").update(`${input.idempotencyKey}:${recipient.id}`).digest("hex").slice(0, 24)
      : undefined;
    if (recipient.phone && line) {
      try {
        const sent = await sendFromManagerWorkNumber({
          managerUserId: input.ownerUserId,
          to: recipient.phone,
          text: `PropLane: ${input.subject}\n${input.text}`.slice(0, 1500),
          fromNumber: line.phoneNumber,
          source: "automated",
          counterpartyRole: "manager",
          purpose: "work_number_extra_recipient_notice",
          dedupeKey: key ? `extra-notice:${key}` : undefined,
          skipLog: true,
        });
        if (sent.ok) texted += 1;
      } catch {
        console.error("extra recipient text failed");
      }
    }
    if (recipient.email) {
      try {
        const outcome = await sendManagerNoticeEmail(db, {
          recipientUserId: `extra:${recipient.id}`,
          toEmail: recipient.email,
          ownerUserId: input.ownerUserId,
          workspaceId: input.workspaceId ?? null,
          subject: input.subject,
          text: input.text,
          url: input.url,
          idempotencyKey: key,
        });
        if (outcome.status === "sent") emailed += 1;
      } catch {
        console.error("extra recipient email failed");
      }
    }
  }
  return { texted, emailed };
}
