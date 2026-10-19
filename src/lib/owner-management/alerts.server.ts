import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { notifyPropertyScopedManagersFromAgent } from "@/lib/co-manager-notification-recipients.server";

/**
 * One plain notice to the manager (and, per the notice spine's rules, the team) about an owner-management event.
 * Idempotent per `key`; never throws, because the money event it reports has already been recorded.
 */
export async function alertManagerOfOwnerEvent(
  db: SupabaseClient,
  input: {
    managerUserId: string;
    workspaceId?: string | null;
    propertyId?: string | null;
    subject: string;
    text: string;
    key: string;
    urgent?: boolean;
  },
): Promise<boolean> {
  try {
    await notifyPropertyScopedManagersFromAgent(db, {
      ownerManagerUserId: input.managerUserId,
      workspaceId: input.workspaceId ?? null,
      propertyId: input.propertyId ?? null,
      module: "financials",
      subject: input.subject,
      text: input.text,
      category: "payment_reminders",
      idempotencyKey: `owner-mgmt:${input.key}`,
      urgent: Boolean(input.urgent),
      eventLabel: input.subject,
      teamNotice: { text: `${input.subject} · ${input.text}`.slice(0, 500), messageId: `owner-mgmt:${input.key}:team` },
    });
    return true;
  } catch (error) {
    console.error("[owner-management] alert failed", error instanceof Error ? error.name : "unknown");
    return false;
  }
}
