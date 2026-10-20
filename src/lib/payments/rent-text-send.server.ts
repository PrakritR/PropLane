import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveWorkspaceForProperty } from "@/lib/one-number/link-destinations.server";
import { sendWorkspaceText, type WorkspaceTextResult } from "@/lib/one-number/link-text.server";

/**
 * One rent text to a resident, from the line of the workspace that holds their house: its own work
 * number, or the PropLane line when the workspace is on it, or (for PropLane's own service workspaces
 * with no number of their own) the service owner's line. A reminder used to read the OWNER's number and
 * send nothing when the workspace had none; this is the one door the rent reminders now share.
 *
 * `purpose` names the text for the consent gate (`payment_reminder`, `weekly_rent_reminder`,
 * `rent_due_link`): the resident's rental-application opt-in is materialized per purpose by the dispatcher,
 * STOP is read first, and nothing here bypasses either.
 */
export async function sendResidentRentText(
  db: SupabaseClient,
  input: {
    ownerUserId: string;
    propertyId: string | null;
    phone: string;
    body: string;
    purpose: string;
    sendClass: "transactional" | "automated";
    idempotencyKey: string;
    residentUserId: string | null;
    residentEmail: string | null;
  },
): Promise<WorkspaceTextResult> {
  const workspaceId = await resolveWorkspaceForProperty(db, input.propertyId, input.ownerUserId).catch(() => null);
  if (!workspaceId) return { ok: false, error: "workspace_unavailable" };
  return sendWorkspaceText(db, {
    workspaceId,
    phoneKey: input.phone,
    body: input.body,
    role: "resident",
    idempotencyKey: input.idempotencyKey,
    propertyId: input.propertyId,
    basis: {
      kind: "resident_notice",
      purpose: input.purpose,
      sendClass: input.sendClass,
      recipientUserId: input.residentUserId,
      recipientEmail: input.residentEmail,
    },
  });
}
