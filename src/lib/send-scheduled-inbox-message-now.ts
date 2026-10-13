import { deliverPortalInboxMessage } from "@/lib/portal-inbox-delivery";
import {
  isResidentOriginatedScheduledMessage,
  loadScheduledInboxMessageForDelivery,
  type ScheduledInboxMessageRecord,
} from "@/lib/scheduled-inbox-messages.server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { sendManagerConversationSms } from "@/lib/manager-sms-send.server";
import { assertManagerCommunicationAllowedForWorkspace } from "@/lib/manager-communication-access.server";

type Channel = "inbox" | "email" | "sms";
type Outcome = "submitted" | "failed" | "unknown" | "skipped" | "claimed";

async function claim(db: SupabaseClient, message: ScheduledInboxMessageRecord, channel: Channel) {
  const { data, error } = await db.rpc("claim_scheduled_inbox_channel", {
    p_message_id: message.id, p_manager_user_id: message.managerUserId, p_channel: channel,
  });
  if (error) throw new Error(`Could not claim scheduled ${channel}: ${error.message}`);
  const row = Array.isArray(data) ? data[0] : data;
  if (!row?.outcome) throw new Error(`Could not claim scheduled ${channel}: empty result`);
  return { outcome: String(row.outcome), token: typeof row.token === "string" ? row.token : null };
}

async function resolve(
  db: SupabaseClient, id: string, channel: Channel, token: string,
  outcome: Exclude<Outcome, "claimed">, errorCode?: string,
) {
  const { data, error } = await db.rpc("resolve_scheduled_inbox_channel", {
    p_message_id: id, p_channel: channel, p_token: token, p_status: outcome, p_error: errorCode ?? null,
  });
  if (error || data !== true) throw new Error(`Could not record scheduled ${channel}: ${error?.message ?? "claim lost"}`);
}

/** Cron and Send now enter this same per-channel claim path. */
export async function sendScheduledInboxMessageNow(
  db: SupabaseClient,
  message: ScheduledInboxMessageRecord,
): Promise<{ ok: boolean; pending?: boolean; error?: string; channels?: Record<Channel, Outcome> }> {
  if (message.smsTestSessionId) {
    return { ok: false, error: "SMS test scheduled messages cannot enter live delivery." };
  }
  if (message.status === "sent") return { ok: true };
  if (message.status !== "scheduled" && message.status !== "sending") {
    return { ok: false, error: "Only scheduled messages can be sent now." };
  }

  const channels: Record<Channel, Outcome> = { inbox: "claimed", email: "claimed", sms: "claimed" };
  try {
    // The first claim changes status to sending; the DB trigger freezes edits.
    const first = await claim(db, message, "inbox");
    if (first.outcome === "sent") return { ok: true };
    if (["missing", "cancelled"].includes(first.outcome)) {
      return { ok: false, error: "Scheduled message is no longer available." };
    }
    const current = await loadScheduledInboxMessageForDelivery(db, message.managerUserId, message.id);
    if (!current || current.status !== "sending") throw new Error("Scheduled message changed during delivery.");
    const active: ScheduledInboxMessageRecord = current;
    const residentOriginated = isResidentOriginatedScheduledMessage(active);
    const senderUserId = residentOriginated ? active.senderUserId?.trim() : active.managerUserId;
    async function preflightFailure(reason: string) {
      if (first.outcome === "claimed" && first.token) {
        await resolve(db, active.id, "inbox", first.token, "failed", reason);
        channels.inbox = "failed";
      }
      return { ok: false, pending: true, channels, error: reason };
    }
    if (!senderUserId) return await preflightFailure("Scheduled sender is missing.");
    // A message scheduled by a manager is outbound Communication: held (and failed, not sent) while
    // the workspace owner is on a live signup trial or the plan cannot be read. A resident writing
    // to their manager is inbound and is never held here.
    if (!residentOriginated) {
      const access = await assertManagerCommunicationAllowedForWorkspace(db, active.managerUserId, active.workspaceId ?? null);
      if (!access.allowed) return await preflightFailure(`communication_${access.reason}`);
    }
    const { data: profile } = await db.from("profiles").select("email, full_name").eq("id", senderUserId).maybeSingle();
    const senderEmail = String(profile?.email ?? "").trim().toLowerCase();
    if (!senderEmail || (residentOriginated && senderEmail !== active.senderEmail?.trim().toLowerCase())) {
      return await preflightFailure("Scheduled sender email changed.");
    }
    if (active.recipientUserId && !active.broadcastCategories?.length) {
      const { data: recipientProfile, error: recipientError } = await db.from("profiles")
        .select("email").eq("id", active.recipientUserId).maybeSingle();
      if (recipientError || !recipientProfile ||
          String(recipientProfile.email ?? "").trim().toLowerCase() !== active.recipientEmail.trim().toLowerCase()) {
        return await preflightFailure("Scheduled recipient account changed.");
      }
    }
    const phoneOnly = Boolean(active.recipientPhone) && !active.recipientEmail && !active.recipientUserId && !active.broadcastCategories?.length && !residentOriginated;
    const fromName = residentOriginated
      ? active.senderName?.trim() || "Resident"
      : profile?.full_name?.trim() || "Property manager";
    const base = {
      senderUserId, senderEmail, fromName, subject: active.subject, text: active.body,
      toEmails: active.broadcastCategories?.length ? [] : [active.recipientEmail],
      toUserIds: active.recipientUserId ? [active.recipientUserId] : [],
      broadcastCategories: active.broadcastCategories,
      eventCategory: "messages" as const,
      senderRole: residentOriginated ? "resident" : undefined,
      messageId: `scheduled:${active.id}`,
      // The workspace the manager composed in, so the recipient scope narrows
      // here exactly as it does on an immediate send.
      senderWorkspaceId: residentOriginated ? null : active.workspaceId ?? null,
    };

    async function run(channel: Channel, preclaimed?: { outcome: string; token: string | null }): Promise<void> {
      const acquired = preclaimed ?? await claim(db, active, channel);
      if (acquired.outcome !== "claimed" || !acquired.token) {
        channels[channel] = acquired.outcome as Outcome;
        return;
      }
      const suppressed = channel === "inbox" ? !active.deliverViaInbox :
        channel === "email" ? !active.deliverViaEmail : !active.deliverViaSms || residentOriginated;
      if (suppressed) {
        await resolve(db, active.id, channel, acquired.token, "skipped");
        channels[channel] = "skipped";
        return;
      }
      try {
        if (channel === "sms" && phoneOnly) {
          // Same outbound path, consent, billing reserve and work number as a manual reply.
          const sent = await sendManagerConversationSms(db, {
            actorUserId: active.managerUserId,
            idempotencyKey: `sched-${active.id}`.padEnd(16, "_").slice(0, 128),
            toPhone: active.recipientPhone ?? "",
            text: active.body,
            conversationKey: active.conversationKey ?? null,
          });
          const sentStatus = String(sent.body.status ?? "");
          const smsOutcome: Exclude<Outcome, "claimed"> =
            sent.status === 409 && sent.body.code === "delivery_outcome_unknown" ? "unknown" :
            sent.status >= 200 && sent.status < 300 ? (sentStatus === "unknown" ? "unknown" : "submitted") : "failed";
          await resolve(db, active.id, channel, acquired.token, smsOutcome,
            smsOutcome === "submitted" ? undefined : String(sent.body.error ?? sent.body.code ?? "sms_failed").slice(0, 200));
          channels[channel] = smsOutcome;
          return;
        }
        const result = await deliverPortalInboxMessage(db, {
          ...base,
          suppressInbox: channel !== "inbox",
          suppressEmail: channel !== "email",
          suppressSms: channel !== "sms",
        });
        if (!result.ok) {
          await resolve(db, active.id, channel, acquired.token, "failed", result.error);
          channels[channel] = "failed";
          return;
        }
        let outcome: Exclude<Outcome, "claimed"> = "submitted";
        if (channel === "email") {
          outcome = result.emailOutcomes.some((item) => item.status === "failed") ? "unknown" :
            result.emailOutcomes.some((item) => item.status === "submitted") ? "submitted" : "skipped";
        } else if (channel === "sms") {
          outcome = result.smsOutcomes.some((item) => ["failed", "unknown"].includes(item.status)) ? "unknown" :
            result.smsOutcomes.some((item) => ["submitted", "queued", "deferred"].includes(item.status)) ? "submitted" : "skipped";
        }
        await resolve(db, active.id, channel, acquired.token, outcome,
          outcome === "unknown" ? `${channel}_provider_outcome_unknown` : undefined);
        channels[channel] = outcome;
      } catch (error) {
        // A thrown provider call can have succeeded before its response was lost.
        await resolve(db, active.id, channel, acquired.token, "unknown", error instanceof Error ? error.message : String(error));
        channels[channel] = "unknown";
      }
    }

    await run("inbox", first);
    await run("email");
    await run("sms");
    const { data: finalized, error: finalError } = await db.rpc("finalize_scheduled_inbox_delivery", {
      p_message_id: active.id, p_manager_user_id: active.managerUserId,
    });
    if (finalError) throw new Error(`Could not finalize scheduled message: ${finalError.message}`);
    return finalized === true
      ? { ok: true, channels }
      : { ok: false, pending: true, channels, error: "Delivery is pending or needs review. Contact support before sending again." };
  } catch (error) {
    return { ok: false, pending: true, channels, error: error instanceof Error ? error.message : String(error) };
  }
}
