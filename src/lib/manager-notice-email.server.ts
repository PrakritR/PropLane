import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { resolveWorkspaceWorkEmail } from "@/lib/manager-assistant-email/manager-assistant-email.server";
import { sendPortalConversationEmails } from "@/lib/portal-email-send.server";

/**
 * The email leg of a PropLane Assistant notice: the notice goes to the
 * recipient's account email FROM the workspace's work email, so the mail reads
 * "PropLane Assistant · <workspace>" and a reply lands in that workspace's
 * assistant mailbox. A teammate's mail leaves from the OWNER's workspace
 * address (a co-manager has no address of their own).
 *
 * Idempotent per (idempotencyKey, recipient): the claim row is written before
 * the send and removed again if the send fails, so a retry resends only what
 * did not go out. A workspace without a work email falls back to the shared
 * PropLane sender (an account notification, as before) rather than silence.
 * Never throws; the in-app notice is the durable one. Masked: no address or
 * body is ever logged.
 */
export type ManagerNoticeEmailOutcome =
  | { status: "sent" }
  | { status: "skipped"; reason: "no_email" | "duplicate" }
  | { status: "failed" };

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function managerNoticeEmailClaimId(recipientUserId: string, idempotencyKey: string): string {
  return `notice_email_${createHash("sha256").update(`${recipientUserId}:${idempotencyKey}`).digest("hex").slice(0, 32)}`;
}

export async function sendManagerNoticeEmail(
  db: SupabaseClient,
  input: {
    recipientUserId: string;
    /** The workspace owner whose work email the mail leaves from. */
    ownerUserId: string;
    /** The notice's workspace; null = the owner's default workspace. */
    workspaceId: string | null;
    subject: string;
    text: string;
    url?: string;
    idempotencyKey?: string;
  },
): Promise<ManagerNoticeEmailOutcome> {
  let claimId: string | null = null;
  try {
    const { data: profile } = await db.from("profiles").select("email").eq("id", input.recipientUserId).maybeSingle();
    const to = String((profile as { email?: unknown } | null)?.email ?? "").trim().toLowerCase();
    if (!to.includes("@")) return { status: "skipped", reason: "no_email" };

    if (input.idempotencyKey?.trim()) {
      claimId = managerNoticeEmailClaimId(input.recipientUserId, input.idempotencyKey.trim());
      const { data: claimed, error } = await db
        .from("portal_outbound_mail_records")
        .upsert(
          {
            id: claimId,
            recipient_email: to,
            subject: input.subject,
            channel: "email",
            row_data: { id: claimId, kind: "manager_notice", sentAt: new Date().toISOString() },
          },
          { onConflict: "id", ignoreDuplicates: true },
        )
        .select("id");
      if (error) return { status: "failed" };
      if (!claimed || claimed.length === 0) return { status: "skipped", reason: "duplicate" };
    }

    const workEmail = await resolveWorkspaceWorkEmail(db, input.ownerUserId, input.workspaceId ?? null).catch(() => null);
    const address = workEmail?.address?.trim() || "";
    const workspaceName = workEmail?.workspaceName?.trim() || "";
    const display = workspaceName ? `PropLane Assistant · ${workspaceName}` : "PropLane Assistant";
    // A display name containing a quote or angle bracket would break the header.
    const fromAddress = address ? (/["<>\r\n]/.test(display) ? address : `${display} <${address}>`) : null;

    const link = `${resolveEmailLinkBaseUrl()}${input.url?.startsWith("/") ? input.url : "/portal/communication/inbox/unopened"}`;
    const text = `${input.text}\n\nOpen in PropLane: ${link}`;
    const html =
      `<p style="white-space:pre-wrap;font-family:sans-serif;font-size:15px;line-height:1.6;color:#1e293b">${escapeHtml(input.text)}</p>` +
      `<p style="font-family:sans-serif;font-size:14px"><a href="${escapeHtml(link)}">Open in PropLane</a></p>`;
    const results = await sendPortalConversationEmails({
      senderUserId: input.ownerUserId,
      toEmails: [to],
      subject: input.subject,
      text,
      html,
      fromAddress,
      omitReplyTo: true,
    });
    if (results.get(to)?.sent === true) return { status: "sent" };
    // Release the claim so the next attempt (a retry of the same notice) sends.
    if (claimId) await db.from("portal_outbound_mail_records").delete().eq("id", claimId);
    return { status: "failed" };
  } catch {
    if (claimId) await db.from("portal_outbound_mail_records").delete().eq("id", claimId).then(undefined, () => undefined);
    return { status: "failed" };
  }
}
