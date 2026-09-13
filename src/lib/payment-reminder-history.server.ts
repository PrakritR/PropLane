import "server-only";

import { loadPaymentReminderChargeForActor } from "@/lib/payment-reminder-capability.server";
import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type ServiceDb = ReturnType<typeof createSupabaseServiceRoleClient>;

export type PaymentReminderHistoryChannel = {
  channel: "email" | "sms" | "inbox";
  status: "claimed" | "submitted" | "failed" | "unknown" | "skipped";
  effectiveStatus: "claimed" | "submitted" | "failed" | "unknown" | "skipped";
  attempts: number;
  submittedAt: string | null;
  updatedAt: string;
  providerReference: string | null;
  /** A provider reference confirms acceptance, not delivery to the recipient. */
  providerAcceptance: "confirmed" | "not_confirmed" | "not_applicable";
  errorCode: string | null;
};

export type PaymentReminderHistoryOccurrence = {
  id: string;
  createdAt: string;
  subject: string;
  coveredChargeIds: string[];
  channels: PaymentReminderHistoryChannel[];
};

const CHANNEL_ORDER = { email: 0, sms: 1, inbox: 2 } as const;
const MAX_OCCURRENCES = 20;

function safeErrorCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const code = value.trim();
  return /^[a-z0-9_:-]{1,80}$/i.test(code) ? code : null;
}

/** The caller must already have authorized the requested charge. */
export async function loadPaymentReminderHistory(input: {
  db: ServiceDb;
  actorUserId: string;
  ownerUserId: string;
  chargeId: string;
  admin: boolean;
  occurrenceId?: string;
  now?: Date;
}): Promise<PaymentReminderHistoryOccurrence[]> {
  const { db, actorUserId, ownerUserId, chargeId, admin } = input;
  let query = db.from("payment_reminder_occurrences")
    .select("id, manager_user_id, charge_ids, subject, created_at")
    .eq("manager_user_id", ownerUserId)
    .contains("charge_ids", [chargeId]);
  if (input.occurrenceId) query = query.eq("id", input.occurrenceId);
  const { data: rows, error } = await query.order("created_at", { ascending: false }).limit(MAX_OCCURRENCES);
  if (error) throw new Error(`Could not read payment reminder history: ${error.message}`);
  if (!rows?.length) return [];

  const visible = [] as typeof rows;
  const access = new Map<string, Promise<boolean>>();
  const canReadCoveredCharge = (id: string): Promise<boolean> => {
    const cached = access.get(id);
    if (cached) return cached;
    const checked = loadPaymentReminderChargeForActor(db, actorUserId, id, admin)
      .then((context) => Boolean(context && context.ownerUserId === ownerUserId));
    access.set(id, checked);
    return checked;
  };
  for (const row of rows) {
    const covered = Array.isArray(row.charge_ids) ? row.charge_ids.filter((id): id is string => typeof id === "string") : [];
    // Owners may see their full historic bundle. A co-manager must currently
    // have both payments/read and Communication/edit for every covered charge;
    // otherwise even the other charge IDs would disclose out-of-scope records.
    if (!admin && actorUserId !== ownerUserId) {
      const allowed = await Promise.all(covered.map(canReadCoveredCharge));
      if (!covered.length || allowed.some((value) => !value)) continue;
    }
    visible.push(row);
  }
  if (!visible.length) return [];

  const occurrenceIds = visible.map((row) => String(row.id));
  const { data: deliveries, error: deliveriesError } = await db
    .from("payment_reminder_channel_deliveries")
    .select("occurrence_id, channel, status, attempts, provider_reference, last_error, submitted_at, claim_expires_at, updated_at")
    .in("occurrence_id", occurrenceIds);
  if (deliveriesError) throw new Error(`Could not read payment reminder channels: ${deliveriesError.message}`);

  const nowMs = (input.now ?? new Date()).getTime();
  const channelsByOccurrence = new Map<string, PaymentReminderHistoryChannel[]>();
  for (const row of deliveries ?? []) {
    if (row.channel !== "email" && row.channel !== "sms" && row.channel !== "inbox") continue;
    if (!["claimed", "submitted", "failed", "unknown", "skipped"].includes(String(row.status))) continue;
    const status = row.status as PaymentReminderHistoryChannel["status"];
    const expired = status === "claimed" && row.claim_expires_at && new Date(row.claim_expires_at).getTime() <= nowMs;
    const reference = typeof row.provider_reference === "string" ? row.provider_reference : null;
    const channel: PaymentReminderHistoryChannel = {
      channel: row.channel,
      status,
      effectiveStatus: expired ? "unknown" : status,
      attempts: Number(row.attempts) || 0,
      submittedAt: typeof row.submitted_at === "string" ? row.submitted_at : null,
      updatedAt: String(row.updated_at),
      providerReference: reference,
      providerAcceptance: row.channel === "inbox" ? "not_applicable" : status === "submitted" && reference ? "confirmed" : "not_confirmed",
      errorCode: safeErrorCode(row.last_error),
    };
    const list = channelsByOccurrence.get(String(row.occurrence_id)) ?? [];
    list.push(channel);
    channelsByOccurrence.set(String(row.occurrence_id), list);
  }

  return visible.map((row) => ({
    id: String(row.id),
    createdAt: String(row.created_at),
    subject: String(row.subject),
    coveredChargeIds: Array.isArray(row.charge_ids) ? row.charge_ids.filter((id): id is string => typeof id === "string") : [],
    channels: (channelsByOccurrence.get(String(row.id)) ?? [])
      .sort((a, b) => CHANNEL_ORDER[a.channel] - CHANNEL_ORDER[b.channel]),
  }));
}
