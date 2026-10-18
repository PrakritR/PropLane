import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { finishCommsCredit, reserveCommsCredit } from "@/lib/comms-billing/wallet.server";
import { readSharedLineConfig, sharedLineActiveFor } from "@/lib/one-number/shared-line-number.server";
import { redactSensitiveNumbers } from "@/lib/one-number/redact";
import { smsSegmentCount, toGsm7 } from "@/lib/one-number/segments";
import { createConversationsGateway } from "./conversations-gateway.server";
import {
  countCappedPostsToday,
  CAP_EXEMPT_KINDS,
  deleteMessage,
  insertMessage,
  loadActiveGroup,
  loadMembers,
  loadMessageByKey,
  loadSettings,
  setMessageSid,
  workspaceOwner,
} from "./store.server";
import { inHouseQuietHours } from "./time";
import type { ConversationsGateway, HouseGroupPostInput, HouseGroupPostResult } from "./types";

export type PostDeps = {
  gateway?: ConversationsGateway | null;
  now?: () => Date;
  /** Outside production a protected account's phone is never texted (`isShieldedRecipient`). */
  shielded?: (phoneE164: string) => Promise<boolean>;
};

async function defaultShielded(phone: string): Promise<boolean> {
  const { isShieldedRecipient } = await import("@/lib/protected-accounts.server");
  return isShieldedRecipient({ phone });
}

/**
 * Post one message into a house's group chat, as PropLane. The single door for every group post:
 * the RA's answers, manager announcements and W11's preset auto-sends.
 *
 *  - `not_enabled`: the line is not shared for this workspace, or its house-chat switch is off.
 *  - `no_group`: this house has no active group (fewer than two consented residents, or not synced).
 *  - `quiet_hours`: 10 pm - 8 am Pacific; only `kind: "emergency"` posts.
 *  - `rate_limited`: the house's daily cap; announcements, emergencies and the intro are exempt.
 *  - `provider_error`: the wallet refused (`detail: "budget"`), a member is shielded, or Twilio failed.
 *
 * The group belongs to `propertyId` AND `workspaceId`: a group of another workspace reads as `no_group`.
 * A retry with the same `idempotencyKey` returns the first send. Billing: every post is MMS to each
 * member, so the workspace wallet is reserved (members x segments) BEFORE Twilio is called and handed
 * back when nothing went out.
 */
export async function postToHouseGroup(
  db: SupabaseClient,
  input: HouseGroupPostInput,
  deps: PostDeps = {},
): Promise<HouseGroupPostResult> {
  const workspaceId = String(input.workspaceId ?? "").trim();
  const propertyId = String(input.propertyId ?? "").trim();
  const key = String(input.idempotencyKey ?? "").trim();
  const text = toGsm7(String(input.text ?? "").trim());
  if (!workspaceId || !propertyId || !key || !text) return { ok: false, reason: "provider_error", detail: "invalid_post" };
  const now = (deps.now ?? (() => new Date()))();

  const config = await readSharedLineConfig(db);
  if (!sharedLineActiveFor(config, workspaceId)) return { ok: false, reason: "not_enabled" };
  const settings = await loadSettings(db, workspaceId);
  if (!settings.enabled) return { ok: false, reason: "not_enabled" };

  const group = await loadActiveGroup(db, propertyId);
  if (!group || group.workspaceId !== workspaceId) return { ok: false, reason: "no_group" };

  const existing = await loadMessageByKey(db, group.id, key);
  if (existing) return { ok: true, messageSid: existing.messageSid ?? "" };

  const emergency = input.kind === "emergency";
  if (!emergency && inHouseQuietHours(now)) return { ok: false, reason: "quiet_hours" };
  if (!CAP_EXEMPT_KINDS.includes(input.kind)) {
    const posted = await countCappedPostsToday(db, group.id, now);
    if (posted >= settings.maxPostsPerDay) return { ok: false, reason: "rate_limited" };
  }

  const members = await loadMembers(db, group.id);
  if (members.length === 0) return { ok: false, reason: "no_group" };
  const shielded = deps.shielded ?? defaultShielded;
  for (const member of members) {
    if (await shielded(member.phoneE164)) return { ok: false, reason: "provider_error", detail: "protected_account_shielded" };
  }

  const gateway = deps.gateway === undefined ? createConversationsGateway() : deps.gateway;
  if (!gateway) return { ok: false, reason: "provider_error", detail: "twilio_not_configured" };
  const ownerUserId = await workspaceOwner(db, workspaceId);
  if (!ownerUserId) return { ok: false, reason: "provider_error", detail: "workspace_unknown" };

  // Claim the key first: a concurrent identical post loses on the unique index and returns the winner.
  const claimed = await insertMessage(db, {
    groupId: group.id,
    workspaceId,
    propertyId,
    direction: "outbound",
    kind: input.kind,
    idempotencyKey: key,
    body: redactSensitiveNumbers(text).text,
  });
  if (!claimed.ok) {
    if (claimed.duplicate) {
      const winner = await loadMessageByKey(db, group.id, key);
      return { ok: true, messageSid: winner?.messageSid ?? "" };
    }
    return { ok: false, reason: "provider_error", detail: "log_unavailable" };
  }

  const creditKey = `house-group:${group.id}:${key}`;
  const quantity = Math.max(1, members.length * smsSegmentCount(text));
  let reserved = false;
  try {
    const credit = await reserveCommsCredit(db, {
      managerUserId: ownerUserId,
      workspaceId,
      meter: "sms_outbound_segment",
      quantity,
      idempotencyKey: creditKey,
      metadata: { kind: "house_group_post", propertyId, members: members.length },
    });
    if (!credit.allowed) {
      await deleteMessage(db, claimed.id);
      return { ok: false, reason: "provider_error", detail: "budget" };
    }
    reserved = true;
  } catch {
    await deleteMessage(db, claimed.id);
    return { ok: false, reason: "provider_error", detail: "budget" };
  }

  try {
    const sent = await gateway.postMessage(group.conversationSid, text);
    await setMessageSid(db, claimed.id, sent.messageSid);
    await finishCommsCredit(db, ownerUserId, creditKey).catch(() => undefined);
    return { ok: true, messageSid: sent.messageSid };
  } catch (error) {
    await deleteMessage(db, claimed.id);
    if (reserved) await finishCommsCredit(db, ownerUserId, creditKey, true).catch(() => undefined);
    return { ok: false, reason: "provider_error", detail: error instanceof Error ? error.message : "send_failed" };
  }
}
