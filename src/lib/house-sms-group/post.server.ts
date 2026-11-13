import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { finishCommsCredit, reserveCommsCredit } from "@/lib/comms-billing/wallet.server";
import { createConversationsGateway } from "@/lib/house-groups/conversations-gateway.server";
import { workspaceOwner } from "@/lib/house-groups/store.server";
import { inHouseQuietHours } from "@/lib/house-groups/time";
import type { ConversationsGateway } from "@/lib/house-groups/types";
import { redactSensitiveNumbers } from "@/lib/one-number/redact";
import { smsSegmentCount, toGsm7 } from "@/lib/one-number/segments";
import { loadHouseSmsGroup, saveSmsGroupState, threadIdFor } from "./store.server";
import { SMS_GROUP_POST_KEYS_KEPT, SMS_GROUP_MAX_TEXT } from "./model";

export type SmsGroupPostKind = "relay" | "intro" | "welcome" | "notice" | "emergency";

export type SmsGroupPostInput = {
  workspaceId: string;
  propertyId: string;
  ownerUserId?: string;
  /** Already includes the sender's label for a relayed line (`groupTextFor`). */
  text: string;
  kind: SmsGroupPostKind;
  /** Stable per intended post: a retry returns the first send instead of posting twice. */
  idempotencyKey: string;
};

export type SmsGroupPostResult =
  | { ok: true; messageSid: string; duplicate?: boolean }
  | { ok: false; reason: "no_group" | "quiet_hours" | "duplicate" | "provider_error"; detail?: string };

export type SmsGroupPostDeps = {
  gateway?: ConversationsGateway | null;
  now?: () => Date;
  /** Outside production a protected account's phone is never texted. */
  shielded?: (phoneE164: string) => Promise<boolean>;
};

async function defaultShielded(phone: string): Promise<boolean> {
  const { isShieldedRecipient } = await import("@/lib/protected-accounts.server");
  return isShieldedRecipient({ phone });
}

/**
 * Post one text into a house's SMS group, from the group's projected line, as PropLane. The ONE door:
 * an in-app line being relayed, the intro, the welcome for a newcomer.
 *
 *  - `no_group`: the house has no ACTIVE Conversation (never made, or fewer than two phones).
 *  - `quiet_hours`: 10 pm - 8 am Pacific for anything PropLane writes itself; a person's own line
 *    (`relay`) and an `emergency` always go.
 *  - `duplicate`: this key already went out.
 *  - `provider_error`: the wallet refused (`detail: "budget"`), a member is a protected account outside
 *    production, or Twilio failed.
 *
 * Billing: a group text is delivered to every phone in it, so `phones x segments` of `sms_outbound_segment`
 * is reserved from the workspace OWNER's comms wallet BEFORE Twilio is called and handed back when nothing
 * went out (a PropLane-managed workspace is billed the same way, per comms-billing). The key is claimed on
 * the stored state first, so a concurrent identical post loses.
 */
export async function postToHouseSmsGroup(
  db: SupabaseClient,
  input: SmsGroupPostInput,
  deps: SmsGroupPostDeps = {},
): Promise<SmsGroupPostResult> {
  const workspaceId = String(input.workspaceId ?? "").trim();
  const propertyId = String(input.propertyId ?? "").trim();
  const key = String(input.idempotencyKey ?? "").trim();
  const text = toGsm7(redactSensitiveNumbers(String(input.text ?? "").trim()).text).slice(0, SMS_GROUP_MAX_TEXT);
  if (!workspaceId || !propertyId || !key || !text) return { ok: false, reason: "provider_error", detail: "invalid_post" };
  const now = (deps.now ?? (() => new Date()))();

  const ownerUserId = input.ownerUserId?.trim() || (await workspaceOwner(db, workspaceId));
  if (!ownerUserId) return { ok: false, reason: "provider_error", detail: "workspace_unknown" };
  const threadId = threadIdFor({ ownerUserId, workspaceId, propertyId });
  const loaded = await loadHouseSmsGroup(db, threadId);
  const state = loaded?.state;
  if (!state || state.status !== "active" || !state.conversationSid || state.members.length === 0) return { ok: false, reason: "no_group" };
  if (state.postKeys.includes(key)) return { ok: true, messageSid: "", duplicate: true };
  if ((input.kind === "intro" || input.kind === "welcome" || input.kind === "notice") && inHouseQuietHours(now)) {
    return { ok: false, reason: "quiet_hours" };
  }

  const shielded = deps.shielded ?? defaultShielded;
  for (const member of state.members) {
    if (await shielded(member.phoneE164)) return { ok: false, reason: "provider_error", detail: "protected_account_shielded" };
  }
  const gateway = deps.gateway === undefined ? createConversationsGateway() : deps.gateway;
  if (!gateway) return { ok: false, reason: "provider_error", detail: "twilio_not_configured" };

  // Claim the key first (compare-and-set on the chat row).
  let claimed = false;
  const saved = await saveSmsGroupState(db, threadId, (current) => {
    if (!current || current.postKeys.includes(key)) return null;
    claimed = true;
    return { ...current, postKeys: [...current.postKeys, key].slice(-SMS_GROUP_POST_KEYS_KEPT) };
  });
  if (!saved) return { ok: false, reason: "provider_error", detail: "log_unavailable" };
  if (!claimed) return { ok: true, messageSid: "", duplicate: true };
  const unclaim = () =>
    saveSmsGroupState(db, threadId, (current) => (current ? { ...current, postKeys: current.postKeys.filter((k) => k !== key) } : null)).catch(() => false);

  const creditKey = `house-sms-group:${state.conversationSid}:${key}`;
  const quantity = Math.max(1, state.members.length * smsSegmentCount(text));
  let reserved = false;
  try {
    const credit = await reserveCommsCredit(db, {
      managerUserId: ownerUserId,
      workspaceId,
      meter: "sms_outbound_segment",
      quantity,
      idempotencyKey: creditKey,
      metadata: { kind: "house_sms_group_post", propertyId, phones: state.members.length },
    });
    if (!credit.allowed) {
      await unclaim();
      return { ok: false, reason: "provider_error", detail: "budget" };
    }
    reserved = true;
  } catch {
    await unclaim();
    return { ok: false, reason: "provider_error", detail: "budget" };
  }

  try {
    const sent = await gateway.postMessage(state.conversationSid, text);
    await finishCommsCredit(db, ownerUserId, creditKey).catch(() => undefined);
    return { ok: true, messageSid: sent.messageSid };
  } catch (error) {
    await unclaim();
    if (reserved) await finishCommsCredit(db, ownerUserId, creditKey, true).catch(() => undefined);
    return { ok: false, reason: "provider_error", detail: error instanceof Error ? error.message : "send_failed" };
  }
}
