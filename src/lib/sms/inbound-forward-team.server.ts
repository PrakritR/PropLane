import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { resolvePropertyScopedManagerRecipientIds } from "@/lib/co-manager-notification-recipients.server";
import { normalizeE164 } from "@/lib/phone-e164";
import { samePhone, senderLabelForInbound } from "@/lib/sms/manager-relay.server";
import { resolveWorkspaceSendLine } from "@/lib/sms/manager-number-provisioning.server";
import { enqueueOwnerSms } from "@/lib/sms/owner-sms-dispatcher.server";
import { TEAM_INBOUND_FORWARD_SMS_PURPOSE } from "@/lib/sms/team-notice-consent.server";
import {
  memberPhoneEligibility,
  resolveWorkspaceTeamMembers,
  teamRelayCapRemaining,
  withdrawTeamRelayIfOverCap,
} from "@/lib/team-comms.server";

/**
 * The house a resident's text is about: the one property every one of their
 * non-voided leases with this owner names. Anything else (no lease, leases on
 * several houses, an unreadable table) is "unknown", and an unknown house
 * forwards to the owner alone, exactly as before.
 */
export async function resolveResidentForwardHouseId(
  db: SupabaseClient,
  input: { ownerManagerUserId: string; residentEmail?: string | null },
): Promise<string | null> {
  const email = input.residentEmail?.trim().toLowerCase() ?? "";
  const owner = input.ownerManagerUserId.trim();
  if (!email || !owner) return null;
  try {
    const { data, error } = await db
      .from("portal_lease_pipeline_records")
      .select("row_data")
      .eq("manager_user_id", owner)
      .eq("resident_email", email);
    if (error) return null;
    const houses = new Set<string>();
    for (const row of (data ?? []) as Array<{ row_data?: { status?: unknown; propertyId?: unknown } | null }>) {
      if (row.row_data?.status === "Voided") continue;
      const id = typeof row.row_data?.propertyId === "string" ? row.row_data.propertyId.trim() : "";
      if (!id) return null; // a lease with no house makes the answer unknowable
      houses.add(id);
    }
    return houses.size === 1 ? [...houses][0]! : null;
  } catch {
    return null;
  }
}

export type TeamForwardOutcome = { memberUserId: string; status: "sent" | "skipped" | "failed"; reason?: string };

/**
 * Forward a resident / prospect text to the TEAMMATES with that house, in
 * addition to the owner's own forward. Recipients: accepted members of the work
 * number's workspace who hold Communication notification on the house, never
 * the owner (their forward is the existing one), never the texter's own phone.
 * Each goes through the same consent gate (verified phone, no STOP, forwarding
 * on) and leaves from the workspace work number, billed to the owner, deduped
 * `fwd:<MessageSid>:<member>`, and counted against the workspace's hourly relay
 * cap. No house, no number, no MessageSid or no credit means no teammate text.
 * Never logs a phone or body.
 */
export async function forwardInboundToTeammates(
  db: SupabaseClient,
  input: {
    managerUserId: string;
    workspaceId: string | null;
    houseId: string | null;
    fromPhone: string;
    body: string;
    messageSid?: string | null;
    now?: Date;
  },
): Promise<TeamForwardOutcome[]> {
  const ownerId = input.managerUserId.trim();
  const houseId = input.houseId?.trim() ?? "";
  const sid = input.messageSid?.trim() ?? "";
  // Unknown house or no MessageSid (nothing to dedupe on) is owner-only.
  if (!ownerId || !houseId || !sid) return [];

  const line = await resolveWorkspaceSendLine(db, ownerId, input.workspaceId).catch(() => null);
  if (!line) return [];

  const [members, withHouse] = await Promise.all([
    resolveWorkspaceTeamMembers(db, { ownerManagerUserId: ownerId, workspaceId: input.workspaceId }),
    resolvePropertyScopedManagerRecipientIds(db as Parameters<typeof resolvePropertyScopedManagerRecipientIds>[0], {
      ownerManagerUserId: ownerId,
      propertyId: houseId,
      channel: "inbox",
    }),
  ]);
  const hasHouse = new Set(withHouse);
  const recipients = members.filter((member) => !member.isOwner && hasHouse.has(member.userId));
  if (recipients.length === 0) return [];

  const label = await senderLabelForInbound(db, { managerUserId: ownerId, fromPhone: input.fromPhone });
  const text = `${label}: ${input.body.trim() || "(no text)"}`.slice(0, 1500);
  let remaining = await teamRelayCapRemaining(db, { ownerManagerUserId: ownerId, numberId: line.numberId, now: input.now });

  const outcomes: TeamForwardOutcome[] = [];
  for (const member of recipients) {
    const eligibility = await memberPhoneEligibility(db, member.userId);
    if (!eligibility.eligible) {
      outcomes.push({ memberUserId: member.userId, status: "skipped", reason: eligibility.reason });
      continue;
    }
    if (samePhone(eligibility.phone, normalizeE164(input.fromPhone) ?? input.fromPhone)) {
      outcomes.push({ memberUserId: member.userId, status: "skipped", reason: "is_sender" });
      continue;
    }
    if (remaining <= 0) {
      outcomes.push({ memberUserId: member.userId, status: "skipped", reason: "hourly_cap" });
      continue;
    }
    remaining -= 1;
    const result = await enqueueOwnerSms(
      {
        managerUserId: ownerId,
        actorUserId: ownerId,
        selectedWorkLineId: line.numberId,
        recipientPhone: eligibility.phone,
        recipientUserId: member.userId,
        body: text,
        sendClass: "transactional",
        purpose: TEAM_INBOUND_FORWARD_SMS_PURPOSE,
        counterpartyRole: "manager",
        propertyId: houseId,
        suppressConversationLog: true,
        dedupeKey: `fwd:${sid}:${member.userId}`,
      },
      db,
    ).catch((error: unknown) => ({ ok: false as const, error: error instanceof Error ? error.message : "send failed" }));
    if (
      result.ok &&
      !result.deduplicated &&
      (await withdrawTeamRelayIfOverCap(db, { ownerManagerUserId: ownerId, numberId: line.numberId, outboxId: result.outboxId, now: input.now }))
    ) {
      outcomes.push({ memberUserId: member.userId, status: "skipped", reason: "hourly_cap" });
      continue;
    }
    outcomes.push(
      result.ok ? { memberUserId: member.userId, status: "sent" } : { memberUserId: member.userId, status: "failed", reason: result.error },
    );
  }
  return outcomes;
}
