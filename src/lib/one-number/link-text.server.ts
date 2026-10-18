import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { loadSharedLineConfig, workspaceOnSharedLine } from "@/lib/one-number/config.server";
import type { PhoneBoundLinkPurpose, SharedLineRole } from "@/lib/one-number/contracts";
import { sendSharedLineMessage } from "@/lib/one-number/send.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { sendFromManagerWorkNumber } from "@/lib/proplane-sms-transport.server";

/** The role a texted code is billed and signed as, by what the person is doing. */
export function roleForLinkPurpose(purpose: PhoneBoundLinkPurpose | "public_apply" | "public_tour"): SharedLineRole {
  switch (purpose) {
    case "lease":
      return "applicant";
    case "rent":
    case "move_in":
      return "resident";
    case "job":
    case "payouts":
      return "vendor";
    default:
      return "prospect";
  }
}

/**
 * Send a one-time-code text to a phone, from the workspace it concerns: through the shared-line
 * sender when the workspace is on the shared line, otherwise from the workspace's own work number
 * (exactly today's path). The destination is whatever the CALLER bound (a link's phone, or the
 * phone someone just typed to prove they hold it); a model or request body never reaches here.
 * Returns whether the text left; a refusal (opted out, no number, quiet hours) is a plain false.
 */
export async function sendWorkspacePhoneText(
  db: SupabaseClient,
  input: {
    workspaceId: string;
    phoneKey: string;
    body: string;
    role: SharedLineRole;
    idempotencyKey: string;
  },
): Promise<boolean> {
  const to = normalizeE164(input.phoneKey);
  if (!to) return false;
  const { data: workspace, error } = await db
    .from("portal_workspaces")
    .select("id, owner_user_id")
    .eq("id", input.workspaceId)
    .maybeSingle();
  const ownerUserId = String((workspace as Record<string, unknown> | null)?.owner_user_id ?? "").trim();
  if (error || !ownerUserId) return false;

  const config = await loadSharedLineConfig(db);
  if (workspaceOnSharedLine(config, input.workspaceId)) {
    const result = await sendSharedLineMessage(db, {
      workspaceId: input.workspaceId,
      ownerUserId,
      toPhone: to,
      body: input.body,
      role: input.role,
      idempotencyKey: input.idempotencyKey,
    });
    if (result.ok) return true;
    // Anything but "the shared sender is not live yet" is a real refusal.
    if (result.reason !== "not_shared_mode") return false;
  }

  const sent = await sendFromManagerWorkNumber({
    managerUserId: ownerUserId,
    to,
    text: input.body,
    sendClass: "transactional",
    purpose: "phone_link_code",
    dedupeKey: input.idempotencyKey,
    // A code is never copied into the Communication thread.
    skipLog: true,
  });
  return sent.ok;
}
