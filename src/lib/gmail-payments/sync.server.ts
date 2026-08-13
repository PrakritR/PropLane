import type { SupabaseClient } from "@supabase/supabase-js";

import { loadManagerManualPaymentSettings } from "@/lib/manager-manual-payment-settings";
import {
  loadPendingChargesForManager,
  loadProcessedReceiptSourceIds,
  markChargePaidFromReceipt,
} from "@/lib/payment-receipt-email/mark-charge-from-receipt.server";
import { markWorkOrderPaidFromVendorReceipt } from "@/lib/payment-receipt-email/mark-work-order-from-receipt.server";
import {
  parseResidentReceiptContext,
  parseWorkOrderPaymentReceiptEmail,
} from "@/lib/payment-receipt-email/parse-receipt";

import { ensureGmailPaymentsAccessToken, listPaymentReceiptMessages } from "./api.server";
import { buildPaymentReceiptGmailQuery, type PaymentReceiptGmailChannel } from "./gmail-query";
import type { GmailPaymentTrackRole, ManagerPaymentReceiptChannel } from "./portal-role";
import { listConnectedManagerReceiptChannels, saveGmailPaymentsConnection } from "./settings";

export type GmailPaymentsSyncResult = {
  scanned: number;
  markedPaid: number;
  unmatched: number;
  ambiguous: number;
  idempotent: number;
  errors: string[];
};

type ReceiptCandidate = {
  msg: { id: string; fromEmail: string; subject: string; body: string };
  receipt: NonNullable<ReturnType<typeof parseResidentReceiptContext>>;
};

async function scanManagerReceiptMessages(
  db: SupabaseClient,
  userId: string,
  channel: ManagerPaymentReceiptChannel | null,
): Promise<{ messages: Awaited<ReturnType<typeof listPaymentReceiptMessages>>; queryChannel: PaymentReceiptGmailChannel }> {
  const queryChannel: PaymentReceiptGmailChannel = channel ?? "all";
  const { accessToken } = await ensureGmailPaymentsAccessToken(db, userId, "manager", channel ?? undefined);
  const messages = await listPaymentReceiptMessages(
    accessToken,
    buildPaymentReceiptGmailQuery(30, queryChannel),
    40,
  );
  return { messages, queryChannel };
}

export async function syncGmailPaymentReceipts(
  db: SupabaseClient,
  userId: string,
  role: GmailPaymentTrackRole,
): Promise<GmailPaymentsSyncResult> {
  if (role === "manager") {
    const settings = await loadManagerManualPaymentSettings(db, userId);
    if (settings.receiptAutoMarkEnabled === false) {
      return { scanned: 0, markedPaid: 0, unmatched: 0, ambiguous: 0, idempotent: 0, errors: ["auto_mark_disabled"] };
    }
  }

  const result: GmailPaymentsSyncResult = {
    scanned: 0,
    markedPaid: 0,
    unmatched: 0,
    ambiguous: 0,
    idempotent: 0,
    errors: [],
  };

  const tally = (outcome: "marked_paid" | "no_match" | "ambiguous" | "idempotent") => {
    switch (outcome) {
      case "marked_paid":
        result.markedPaid += 1;
        break;
      case "no_match":
        result.unmatched += 1;
        break;
      case "ambiguous":
        result.ambiguous += 1;
        break;
      case "idempotent":
        result.idempotent += 1;
        break;
    }
  };

  if (role === "manager") {
    const inboxes = await listConnectedManagerReceiptChannels(db, userId);
    if (inboxes.length === 0) {
      result.errors.push("gmail_not_connected");
      return result;
    }

    const seenMessageIds = new Set<string>();
    const candidates: ReceiptCandidate[] = [];

    for (const { channel } of inboxes) {
      try {
        const { messages } = await scanManagerReceiptMessages(db, userId, channel);
        result.scanned += messages.length;
        for (const msg of messages) {
          if (seenMessageIds.has(msg.id)) continue;
          seenMessageIds.add(msg.id);
          const receipt = parseResidentReceiptContext({
            fromEmail: msg.fromEmail,
            subject: msg.subject,
            body: msg.body,
          });
          if (receipt) {
            candidates.push({ msg, receipt });
          }
        }
        await saveGmailPaymentsConnection(
          db,
          userId,
          "manager",
          {
            lastSyncAt: new Date().toISOString(),
            lastSyncMarkedPaid: result.markedPaid,
          },
          channel ?? undefined,
        );
      } catch (e) {
        result.errors.push(e instanceof Error ? e.message : "sync error");
      }
    }

    if (candidates.length > 0) {
      try {
        const processedIds = await loadProcessedReceiptSourceIds(
          db,
          "paidViaGmailMessageId",
          candidates.map((c) => c.msg.id),
        );
        let pending = await loadPendingChargesForManager(db, userId);
        for (const { msg, receipt } of candidates) {
          try {
            const outcome = await markChargePaidFromReceipt(db, userId, receipt, {
              sourceId: msg.id,
              sourceField: "paidViaGmailMessageId",
              preloaded: { alreadyProcessed: processedIds.has(msg.id), pendingCharges: pending },
            });
            if (outcome.outcome === "marked_paid") {
              pending = pending.filter((c) => c.id !== outcome.chargeId);
            }
            tally(outcome.outcome);
          } catch (e) {
            result.errors.push(e instanceof Error ? e.message : "sync error");
          }
        }
      } catch (e) {
        result.errors.push(e instanceof Error ? e.message : "sync error");
      }
    }

    return result;
  }

  const { accessToken } = await ensureGmailPaymentsAccessToken(db, userId, role);
  const messages = await listPaymentReceiptMessages(accessToken, buildPaymentReceiptGmailQuery(30), 40);
  result.scanned = messages.length;

  for (const msg of messages) {
    try {
      const receipt = parseWorkOrderPaymentReceiptEmail({
        fromEmail: msg.fromEmail,
        subject: msg.subject,
        body: msg.body,
      });
      if (!receipt) continue;
      const outcome = await markWorkOrderPaidFromVendorReceipt(db, userId, receipt, msg.id);
      tally(outcome.outcome);
    } catch (e) {
      result.errors.push(e instanceof Error ? e.message : "sync error");
    }
  }

  await saveGmailPaymentsConnection(db, userId, role, {
    lastSyncAt: new Date().toISOString(),
    lastSyncMarkedPaid: result.markedPaid,
  });

  return result;
}
