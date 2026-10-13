import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { notifyManagerFromAgent } from "@/lib/agent-notify.server";
import type { CoManagerPermissionId } from "@/lib/co-manager-permissions";
import { resolveWorkspaceNoticeRecipients } from "@/lib/workspace-team-recipients.server";

function firstChars(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** "Work email from <sender> · <subject> · <first 120 chars>". */
export function inboundEmailNoticeText(input: { sender: string; subject: string; body: string }): string {
  const subject = input.subject.trim() || "(no subject)";
  return `Work email from ${input.sender.trim()} · ${subject} · ${firstChars(input.body, 120)}`;
}

/** "Replied: <first 120 chars>". */
export function repliedNoticeText(reply: string): string {
  return `Replied: ${firstChars(reply, 120)}`;
}

/**
 * Tell every NON-owner recipient the role matrix names (the owner already has
 * the conversation in their own inbox) about inbound traffic or the answer the
 * agent sent. Each notice lands in the person's OWN PropLane Assistant thread
 * for this workspace (never the Team chat) and rides their own routing, with
 * texts leaving from the owner's work number and billed to the owner. One
 * person's failure never blocks the rest; nothing here throws. `idempotencyKey`
 * makes a redelivered webhook a no-op per person.
 */
export async function fanOutWorkspaceNotice(
  db: SupabaseClient,
  input: {
    ownerUserId: string;
    workspaceId?: string | null;
    module?: CoManagerPermissionId;
    propertyId?: string | null;
    subject: string;
    text: string;
    idempotencyKey: string;
    url?: string;
    /** false = no text to the teammate (the caller already texts them through the forward path). */
    sms?: boolean;
  },
): Promise<{ notified: number }> {
  const ownerId = input.ownerUserId.trim();
  if (!ownerId || !input.idempotencyKey) return { notified: 0 };
  let notified = 0;
  try {
    const recipients = await resolveWorkspaceNoticeRecipients(db, {
      ownerUserId: ownerId,
      workspaceId: input.workspaceId,
      module: input.module ?? "inbox",
      propertyId: input.propertyId,
    });
    for (const recipient of recipients) {
      if (recipient.isOwner) continue;
      try {
        await notifyManagerFromAgent(db, {
          landlordId: recipient.userId,
          subject: input.subject,
          text: input.text,
          threadType: "workspace_inbound",
          url: input.url,
          category: "messages",
          idempotencyKey: input.idempotencyKey,
          propertyId: input.propertyId ?? null,
          workspaceId: input.workspaceId ?? null,
          senderOwnerId: ownerId,
          ...(input.sms === false ? { notify: { push: true, sms: false } } : {}),
        });
        notified += 1;
      } catch (error) {
        // Masked: neither the teammate id nor the body reaches a log.
        console.error("workspace inbound notice failed", error instanceof Error ? error.name : "unknown");
      }
    }
  } catch (error) {
    console.error("workspace inbound fan-out failed", error instanceof Error ? error.name : "unknown");
  }
  return { notified };
}
