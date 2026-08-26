/**
 * Proxy-pair SMS relay (see supabase/migrations/20260718120000_sms_relay_pool.sql).
 *
 * A manager and a resident text each other from personal phones through a
 * pooled Twilio number; neither sees the other's real number. Routing is the
 * unique active pair (participant_phone, proxy_phone) → thread + role.
 *
 * Relay numbers are disjoint from per-manager work numbers
 * (profiles.sms_from_number): the inbound webhook tries a relay binding first
 * and only then falls back to the work-number → Axis-inbox path.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { smsMediaAppUrl, storeInboundMedia } from "@/lib/sms-media.server";
import { upsertManagerInboxNotice } from "@/lib/sms-inbox-notice.server";
import { normalizeE164, sendSms } from "@/lib/twilio";
import { createTwilioRestClient } from "@/lib/twilio-client.server";

const RELAY_AREA_CODES = [206, 425, 253, 415, 510];
export const RELAY_POOL_TARGET_FREE = 5;
// Hard cost cap — a runaway auto-buy loop is ~$1.15 per iteration.
export const RELAY_POOL_MAX = 100;
// Abuse containment: each provision sends an unsolicited intro SMS to an
// arbitrary number and holds a pooled number, so both are per-manager bounded.
export const RELAY_MAX_ACTIVE_THREADS_PER_MANAGER = 5;
export const RELAY_PROVISION_MIN_INTERVAL_MS = 60_000;

function twilioClient() {
  return createTwilioRestClient();
}

export type RelayNumberRow = {
  id: string;
  phone_e164: string;
  twilio_sid: string;
  status: string;
  cooldown_until: string | null;
};

/**
 * Buy one SMS+MMS-capable local number and attach it to the Messaging Service
 * so it inherits the A2P campaign. The attach is a SEPARATE Twilio call — a
 * number that skips it gets carrier-filtered, so a failed attach releases the
 * number rather than orphaning it.
 */
export async function buyAndEnrollRelayNumber(
  db: SupabaseClient,
): Promise<{ ok: true; phone: string } | { ok: false; error: string }> {
  const client = twilioClient();
  if (!client) return { ok: false, error: "Twilio is not configured." };
  const messagingServiceSid = process.env.TWILIO_MESSAGING_SERVICE_SID?.trim();
  if (!messagingServiceSid) {
    return { ok: false, error: "TWILIO_MESSAGING_SERVICE_SID is not set — numbers must join the A2P campaign." };
  }

  let lastError = "No numbers available in any configured area code.";
  for (const areaCode of RELAY_AREA_CODES) {
    try {
      const [candidate] = await client
        .availablePhoneNumbers("US")
        .local.list({ areaCode, smsEnabled: true, mmsEnabled: true, limit: 1 });
      if (!candidate) continue;

      const bought = await client.incomingPhoneNumbers.create({
        phoneNumber: candidate.phoneNumber,
        friendlyName: "proplane-relay-pool",
      });
      try {
        await client.messaging.v1
          .services(messagingServiceSid)
          .phoneNumbers.create({ phoneNumberSid: bought.sid });
      } catch (e) {
        await client.incomingPhoneNumbers(bought.sid).remove().catch(() => undefined);
        throw e;
      }

      const { error } = await db
        .from("sms_relay_numbers")
        .insert({ phone_e164: bought.phoneNumber, twilio_sid: bought.sid });
      if (error) return { ok: false, error: error.message };
      return { ok: true, phone: bought.phoneNumber };
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
    }
  }
  return { ok: false, error: lastError };
}

/**
 * Keep TARGET_FREE numbers warm (registration propagation is not instant, so
 * just-in-time buying risks the first message being filtered), capped at
 * RELAY_POOL_MAX. Returns what it did so the cron can report.
 */
export async function releaseExpiredRelayCooldowns(db: SupabaseClient): Promise<number> {
  const { data } = await db
    .from("sms_relay_numbers")
    .update({ status: "available", cooldown_until: null })
    .eq("status", "cooldown")
    .lte("cooldown_until", new Date().toISOString())
    .select("id");
  return (data ?? []).length;
}

export async function topUpRelayPool(
  db: SupabaseClient,
): Promise<{ total: number; free: number; bought: number; errors: string[] }> {
  await releaseExpiredRelayCooldowns(db);

  const { count: total } = await db
    .from("sms_relay_numbers")
    .select("*", { count: "exact", head: true });
  const { data: available } = await db
    .from("sms_relay_numbers")
    .select("id")
    .eq("status", "available");
  const { data: activeThreads } = await db
    .from("sms_relay_threads")
    .select("proxy_number_id")
    .eq("state", "active");

  const inUse = new Set((activeThreads ?? []).map((t) => String(t.proxy_number_id)));
  const free = (available ?? []).filter((n) => !inUse.has(String(n.id))).length;

  let bought = 0;
  const errors: string[] = [];
  let poolSize = total ?? 0;
  while (bought + free < RELAY_POOL_TARGET_FREE && poolSize < RELAY_POOL_MAX) {
    const result = await buyAndEnrollRelayNumber(db);
    if (!result.ok) {
      errors.push(result.error);
      break;
    }
    bought += 1;
    poolSize += 1;
  }
  return { total: poolSize, free: free + bought, bought, errors };
}

export type ProvisionRelayThreadInput = {
  managerUserId: string;
  managerPhone: string; // verified personal cell
  managerName: string;
  counterpartyPhone: string;
  counterpartyUserId?: string | null;
  counterpartyName?: string | null;
  label?: string | null; // e.g. unit address shown in intro texts
};

/**
 * Allocate a proxy number for this manager, create the thread + both bindings,
 * and send each side its intro text. The pair-uniqueness index makes a racing
 * duplicate fail loudly instead of routing ambiguously.
 */
export async function provisionRelayThread(
  db: SupabaseClient,
  input: ProvisionRelayThreadInput,
): Promise<{ ok: true; threadId: string; proxyPhone: string } | { ok: false; error: string; status?: number }> {
  const managerPhone = normalizeE164(input.managerPhone);
  const counterpartyPhone = normalizeE164(input.counterpartyPhone);
  if (!managerPhone || !counterpartyPhone) return { ok: false, error: "Invalid phone number.", status: 400 };
  if (managerPhone === counterpartyPhone) {
    return { ok: false, error: "Manager and resident phone are the same number.", status: 400 };
  }

  const { count: activeThreads } = await db
    .from("sms_relay_threads")
    .select("*", { count: "exact", head: true })
    .eq("manager_user_id", input.managerUserId)
    .eq("state", "active");
  if ((activeThreads ?? 0) >= RELAY_MAX_ACTIVE_THREADS_PER_MANAGER) {
    return {
      ok: false,
      error: `You can have at most ${RELAY_MAX_ACTIVE_THREADS_PER_MANAGER} open text relays. Close one before opening another.`,
      status: 409,
    };
  }
  const { data: lastThread } = await db
    .from("sms_relay_threads")
    .select("created_at")
    .eq("manager_user_id", input.managerUserId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const lastCreatedAt = lastThread?.created_at ? new Date(String(lastThread.created_at)).getTime() : 0;
  if (lastCreatedAt && Date.now() - lastCreatedAt < RELAY_PROVISION_MIN_INTERVAL_MS) {
    return { ok: false, error: "Please wait a minute between opening text relays.", status: 429 };
  }

  const { data: numberId, error: allocError } = await db.rpc("allocate_sms_proxy_number", {
    p_manager_id: input.managerUserId,
  });
  if (allocError) return { ok: false, error: allocError.message, status: 500 };
  if (!numberId) {
    return { ok: false, error: "No relay numbers available — the pool needs a top-up.", status: 409 };
  }

  const { data: numberRow } = await db
    .from("sms_relay_numbers")
    .select("id, phone_e164")
    .eq("id", numberId)
    .maybeSingle();
  const proxyPhone = String(numberRow?.phone_e164 ?? "");
  if (!proxyPhone) return { ok: false, error: "Allocated number row missing.", status: 500 };

  const { data: thread, error: threadError } = await db
    .from("sms_relay_threads")
    .insert({
      manager_user_id: input.managerUserId,
      proxy_number_id: numberId,
      counterparty_user_id: input.counterpartyUserId ?? null,
      counterparty_name: input.counterpartyName ?? null,
      label: input.label ?? null,
    })
    .select("id")
    .single();
  if (threadError || !thread) return { ok: false, error: threadError?.message ?? "Thread insert failed.", status: 500 };

  const { error: bindingError } = await db.from("sms_relay_bindings").insert([
    {
      thread_id: thread.id,
      user_id: input.managerUserId,
      role: "manager",
      participant_phone: managerPhone,
      proxy_phone: proxyPhone,
    },
    {
      thread_id: thread.id,
      user_id: input.counterpartyUserId ?? null,
      role: "resident",
      participant_phone: counterpartyPhone,
      proxy_phone: proxyPhone,
    },
  ]);
  if (bindingError) {
    // Most likely the pair-uniqueness index: this participant already has an
    // active thread on this proxy. Roll the thread back so the number frees up.
    await db.from("sms_relay_threads").delete().eq("id", thread.id);
    const message =
      bindingError.code === "23505"
        ? "An active text relay already exists for one of these phone numbers on this proxy number."
        : bindingError.message;
    return { ok: false, error: message, status: 409 };
  }

  const where = input.label ? ` for ${input.label}` : "";
  await sendSms(
    counterpartyPhone,
    `PropLane: this is your direct line${where}. Text here to reach ${input.managerName}, your property manager. Reply STOP to opt out, HELP for help.`,
    proxyPhone,
  ).catch(() => undefined);
  await sendSms(
    managerPhone,
    `PropLane: ${input.counterpartyName || "your resident"}${where ? ` (${input.label})` : ""} is now connected. Save this number as "${input.counterpartyName || "Resident"} — PropLane". Anything you text to it goes straight to them.`,
    proxyPhone,
    { skipOptOutCheck: true },
  ).catch(() => undefined);

  return { ok: true, threadId: String(thread.id), proxyPhone };
}

/**
 * Close a thread: deactivate bindings and put the number on a 30-day cooldown
 * so a former tenant texting the old number can never land in a new tenant's
 * thread. The number stays in the pool (keeps its campaign registration).
 */
export async function closeRelayThread(
  db: SupabaseClient,
  args: { threadId: string; managerUserId: string },
): Promise<{ ok: boolean; error?: string }> {
  const { data: thread } = await db
    .from("sms_relay_threads")
    .select("id, proxy_number_id, state")
    .eq("id", args.threadId)
    .eq("manager_user_id", args.managerUserId)
    .maybeSingle();
  if (!thread) return { ok: false, error: "Thread not found." };
  if (thread.state === "closed") return { ok: true };

  await closeThreadRow(db, { id: String(thread.id), proxyNumberId: String(thread.proxy_number_id) });
  return { ok: true };
}

async function closeThreadRow(
  db: SupabaseClient,
  thread: { id: string; proxyNumberId: string },
): Promise<void> {
  await db.from("sms_relay_bindings").update({ active: false }).eq("thread_id", thread.id);
  await db
    .from("sms_relay_threads")
    .update({ state: "closed", closed_at: new Date().toISOString() })
    .eq("id", thread.id);
  await db
    .from("sms_relay_numbers")
    .update({
      status: "cooldown",
      cooldown_until: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    })
    .eq("id", thread.proxyNumberId);
}

/**
 * Account-deletion sweep: a deleted user's real cell must stop routing.
 * sms_relay_bindings.user_id and counterparty_user_id have no auth.users FK
 * (only manager-owned threads cascade), so this deactivates every binding the
 * user participates in and closes the affected threads, cooling down their
 * numbers exactly like a manual close.
 */
export async function closeRelayThreadsForUser(db: SupabaseClient, userId: string): Promise<void> {
  const { data: bindingRows } = await db
    .from("sms_relay_bindings")
    .select("thread_id")
    .eq("user_id", userId);
  const { data: managerThreads } = await db
    .from("sms_relay_threads")
    .select("id")
    .eq("manager_user_id", userId);

  // Bindings provisioned before the counterparty had an account carry
  // user_id: null — they can only be matched by phone. Match against the
  // profile phone ONLY when it is OTP-verified: an unverified (possibly
  // typo'd) number must never close a stranger's thread.
  const { data: profile } = await db
    .from("profiles")
    .select("phone, phone_verified_at")
    .eq("id", userId)
    .maybeSingle();
  const verifiedPhone = profile?.phone_verified_at ? normalizeE164(String(profile.phone ?? "")) : null;
  const { data: phoneBindingRows } = verifiedPhone
    ? await db
        .from("sms_relay_bindings")
        .select("thread_id")
        .eq("participant_phone", verifiedPhone)
        .eq("active", true)
    : { data: null };

  const threadIds = [
    ...new Set([
      ...(bindingRows ?? []).map((r) => String(r.thread_id)),
      ...(phoneBindingRows ?? []).map((r) => String(r.thread_id)),
      ...(managerThreads ?? []).map((r) => String(r.id)),
    ]),
  ];
  for (const threadId of threadIds) {
    const { data: thread } = await db
      .from("sms_relay_threads")
      .select("id, proxy_number_id, state")
      .eq("id", threadId)
      .maybeSingle();
    if (!thread || thread.state === "closed") continue;
    await closeThreadRow(db, { id: String(thread.id), proxyNumberId: String(thread.proxy_number_id) });
  }
}

export type RelayInboundResult =
  | { handled: false }
  | { handled: true; reply?: string; managerUserId?: string; senderUserId?: string };

/**
 * Webhook-time routing: look up (From, To) among active bindings. A hit relays
 * the message to every OTHER participant with a role prefix, stores it, and
 * mirrors it into the manager's Axis inbox. A miss on a pool-owned number gets
 * a "not linked" auto-reply; a miss on a non-pool number returns handled:false
 * so the work-number path can take over.
 */
export async function relayInboundSms(
  db: SupabaseClient,
  args: { fromPhone: string; toPhone: string; body: string; messageSid: string | null; mediaUrls?: string[] },
): Promise<RelayInboundResult> {
  const from = normalizeE164(args.fromPhone) ?? args.fromPhone;
  const to = normalizeE164(args.toPhone) ?? args.toPhone;

  const { data: senderRows } = await db
    .from("sms_relay_bindings")
    .select("id, thread_id, role, user_id")
    .eq("proxy_phone", to)
    .eq("participant_phone", from)
    .eq("active", true)
    .limit(1);
  const sender = (senderRows ?? [])[0];

  if (!sender) {
    // Only claim the message if the number belongs to the relay pool.
    const { data: poolRows } = await db
      .from("sms_relay_numbers")
      .select("id")
      .eq("phone_e164", to)
      .limit(1);
    if ((poolRows ?? []).length === 0) return { handled: false };
    return {
      handled: true,
      reply: "This number isn't linked to an active PropLane conversation. Please message through the PropLane app.",
    };
  }

  const { data: thread } = await db
    .from("sms_relay_threads")
    .select("id, manager_user_id, counterparty_name, label")
    .eq("id", sender.thread_id)
    .maybeSingle();
  if (!thread) return { handled: true };

  const managerUserId = String(thread.manager_user_id);
  const senderUserId = sender.user_id ? String(sender.user_id) : undefined;

  // Copy MMS attachments out of Twilio into our bucket. The durable bucket
  // PATHS are what gets persisted; the signed URLs only feed the immediate
  // outbound relay legs. (Re-running on a webhook retry just re-upserts the
  // same objects.)
  const storedMedia = args.mediaUrls?.length
    ? await storeInboundMedia(db, {
        managerUserId,
        messageSid: args.messageSid ?? `unknown_${Date.now()}`,
        mediaUrls: args.mediaUrls,
      })
    : [];

  // Idempotent store: Twilio retries on any non-2xx/timeout.
  const { error: insertError } = await db.from("sms_relay_messages").insert({
    thread_id: sender.thread_id,
    manager_user_id: thread.manager_user_id,
    twilio_sid: args.messageSid,
    sender_user_id: sender.user_id,
    sender_role: sender.role,
    channel_in: "sms",
    body: args.body,
    media_urls: storedMedia.length ? storedMedia.map((m) => m.path) : null,
  });
  if (insertError?.code === "23505") return { handled: true, managerUserId, senderUserId };

  const { data: recipients } = await db
    .from("sms_relay_bindings")
    .select("participant_phone")
    .eq("thread_id", sender.thread_id)
    .eq("active", true)
    .neq("id", sender.id);

  // Twilio never echoes to the sender, so each side only ever sees the OTHER
  // party's prefix.
  const prefix = sender.role === "manager" ? "Manager: " : "Resident: ";
  const outBody = `${prefix}${args.body}`.slice(0, 1500);
  for (const recipient of recipients ?? []) {
    await sendSms(String(recipient.participant_phone), outBody, to, {
      mediaUrls: storedMedia.map((m) => m.signedUrl),
    }).catch(() => undefined);
  }

  // Mirror into the manager's Axis inbox so the conversation exists in-app.
  const counterpartyLabel = String(thread.counterparty_name ?? "").trim() || "Resident";
  const threadLabel = String(thread.label ?? "").trim();
  const mediaNote = storedMedia.length
    ? `\n\nAttachments:\n${storedMedia.map((m) => smsMediaAppUrl(m.path)).join("\n")}`
    : "";
  await upsertManagerInboxNotice(db, {
    managerUserId,
    idPrefix: `sms_relay_${sender.thread_id}`,
    threadType: "sms_relay",
    folder: sender.role === "manager" ? "sent" : "inbox",
    from: sender.role === "manager" ? "You (via text)" : counterpartyLabel,
    subject: `Text relay — ${counterpartyLabel}${threadLabel ? ` (${threadLabel})` : ""}`,
    preview: args.body,
    body: `${args.body}${mediaNote}`,
    unread: sender.role !== "manager",
  });

  return { handled: true, managerUserId, senderUserId };
}
