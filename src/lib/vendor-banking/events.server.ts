import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { emitActionEvent, type ActionEventAudience } from "@/lib/action-events.server";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { PRIMARY_ADMIN_EMAIL } from "@/lib/auth/primary-admin";
import {
  renderVendorBankingEvent,
  type VendorBankingEventFacts,
  type VendorBankingEventKind,
} from "@/lib/vendor-banking/events";

export { renderVendorBankingEvent } from "@/lib/vendor-banking/events";
export type { VendorBankingEventFacts, VendorBankingEventKind } from "@/lib/vendor-banking/events";

/**
 * Vendor banking moments on the automated-communication spine
 * (docs/agents/automated-communication.md): one `emitActionEvent` per moment,
 * idempotent on `eventId`, delivered by the recipient's own notification
 * preferences (vendors: Settings -> Notifications -> Payments; managers: alert
 * routing). Never throws into a money path: every caller is a webhook or a
 * settlement that has already committed.
 */

const VENDOR_AUDIENCE_KINDS: ReadonlySet<VendorBankingEventKind> = new Set([
  "payout_paid",
  "payout_failed",
  "payout_returned",
  "bank_removed",
  "bank_needs_verification",
  "account_restricted",
  "refund_sent",
  "dispute_opened",
  "dispute_closed",
  "money_held_no_bank",
]);
const MANAGER_AUDIENCE_KINDS: ReadonlySet<VendorBankingEventKind> = new Set([
  "refund_received",
  "dispute_opened",
  "dispute_closed",
]);

export function audiencesForVendorBankingEvent(kind: VendorBankingEventKind): ActionEventAudience[] {
  const out: ActionEventAudience[] = [];
  if (VENDOR_AUDIENCE_KINDS.has(kind)) out.push("vendor");
  if (MANAGER_AUDIENCE_KINDS.has(kind)) out.push("manager");
  return out;
}

async function profileContact(db: SupabaseClient, userId: string) {
  const { data } = await db.from("profiles").select("email, full_name").eq("id", userId).maybeSingle();
  return {
    email: String((data as { email?: string } | null)?.email ?? "").trim().toLowerCase(),
    name: String((data as { full_name?: string } | null)?.full_name ?? "").trim() || undefined,
  };
}

/**
 * Moments that are about the VENDOR'S OWN account — their bank, their payout,
 * their Stripe status — and nobody else's. PropLane sends these itself: no
 * manager did the thing being reported, and a vendor who has never been paid
 * through PropLane (no `vendor_payouts` row, so no manager to borrow a name
 * from) is exactly the person who most needs "your account was restricted".
 *
 * Everything else here is cross-party (a refund, a dispute) and still goes out
 * in the name of the manager involved.
 */
const PROPLANE_SENT_KINDS: ReadonlySet<VendorBankingEventKind> = new Set([
  "payout_paid",
  "payout_failed",
  "payout_returned",
  "bank_removed",
  "bank_needs_verification",
  "account_restricted",
  "money_held_no_bank",
]);

/** The name a PropLane system notice goes out under. */
const PROPLANE_SENDER_NAME = "PropLane";

/**
 * PropLane's own ops identity — the ONLY identity a PropLane system notice is
 * ever sent under. There is deliberately no manager fallback: the From address,
 * the Reply-To and the vendor's conversation identity all derive from this one
 * account downstream, so borrowing a manager's would email "your Stripe account
 * was restricted" from that manager's work address and route the vendor's reply
 * to someone who had nothing to do with the event.
 *
 * `profiles.email` carries no unique constraint (see `primary-admin.ts`), so
 * this takes the OLDEST matching row rather than asking for exactly one — two
 * rows must not disable the whole PropLane-sender path. A read failure and a
 * missing identity are logged separately; either one means the notice is not
 * sent, because production always provisions this account
 * (`scripts/ensure-admin-account.mjs`) and its absence is a misconfiguration,
 * never a state to degrade around.
 */
async function proplaneSystemSender(
  db: SupabaseClient,
): Promise<{ userId: string; email: string; name: string } | null> {
  const { data, error } = await db
    .from("profiles")
    .select("id, email")
    .eq("email", PRIMARY_ADMIN_EMAIL.trim().toLowerCase())
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .limit(1);
  if (error) {
    console.error("[vendor-banking] could not resolve the PropLane sender:", error.message);
    return null;
  }
  const row = (data as Array<{ id?: string; email?: string }> | null)?.[0] ?? null;
  const userId = String(row?.id ?? "").trim();
  const email = String(row?.email ?? "").trim().toLowerCase();
  if (!userId || !email) {
    console.error(`[vendor-banking] no PropLane ops profile for ${PRIMARY_ADMIN_EMAIL}`);
    return null;
  }
  return { userId, email, name: PROPLANE_SENDER_NAME };
}

/** The manager a cross-party notice is sent as: the vendor's most recent paying manager. */
async function latestPayingManagerId(db: SupabaseClient, vendorUserId: string): Promise<string | null> {
  const { data } = await db
    .from("vendor_payouts")
    .select("manager_user_id")
    .eq("vendor_user_id", vendorUserId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  const id = (data as { manager_user_id?: string } | null)?.manager_user_id;
  return id ? String(id) : null;
}

/** Why a notice did not go out. Absent when `sent` is true. */
export type VendorBankingEventOutcome = {
  sent: boolean;
  reason?: "proplane_sender_missing" | "no_manager_sender" | "no_recipients" | "emit_failed";
};

export async function emitVendorBankingEvent(
  db: SupabaseClient,
  input: {
    kind: VendorBankingEventKind;
    /** Idempotency: the same moment always carries the same id. */
    eventId: string;
    vendorUserId: string;
    managerUserId?: string | null;
    facts: VendorBankingEventFacts;
  },
): Promise<VendorBankingEventOutcome> {
  try {
    // Whether a manager authored this moment is a property of the KIND, never
    // of which account happens to be available as the From address. A
    // PropLane-sent kind goes out as PropLane or not at all — never under a
    // manager's identity, since every downstream address derives from the
    // sender's user id.
    const proplaneSent = PROPLANE_SENT_KINDS.has(input.kind);
    let sender: { userId: string; email: string; name?: string } | null = null;
    if (proplaneSent) {
      sender = await proplaneSystemSender(db);
      if (!sender) {
        console.error(
          `[vendor-banking] notification ${input.kind} NOT SENT for vendor ${input.vendorUserId}: the PropLane ops account is missing, and a PropLane notice is never sent under a manager's identity`,
        );
        return { sent: false, reason: "proplane_sender_missing" };
      }
    } else {
      const managerUserId = input.managerUserId ?? (await latestPayingManagerId(db, input.vendorUserId));
      const contact = managerUserId ? await profileContact(db, managerUserId) : null;
      if (!managerUserId || !contact?.email) {
        console.error(
          `[vendor-banking] notification ${input.kind} dropped: no sender for vendor ${input.vendorUserId}`,
        );
        return { sent: false, reason: "no_manager_sender" };
      }
      sender = { userId: managerUserId, email: contact.email, name: contact.name };
    }
    const base = resolveEmailLinkBaseUrl().replace(/\/$/, "");
    const senderUserId = sender.userId;
    const recipients = audiencesForVendorBankingEvent(input.kind).flatMap((audience) => {
      const rendered = renderVendorBankingEvent(input.kind, audience, input.facts);
      if (!rendered) return [];
      // A manager copy only exists for a cross-party kind, which never takes
      // the PropLane sender — so the manager audience is the sender's own id.
      const userId = audience === "vendor" ? input.vendorUserId : senderUserId;
      const path = audience === "vendor" ? "/vendor/finances" : "/portal/payments";
      return [
        {
          audience,
          userId,
          rendered: { ...rendered, text: `${rendered.text}\n\n${base}${path}` },
        },
      ];
    });
    if (recipients.length === 0) return { sent: false, reason: "no_recipients" };
    await emitActionEvent(db, {
      eventId: `vendor_banking:${input.eventId}`,
      domain: "vendor_banking",
      event: input.kind,
      managerUserId: senderUserId,
      entityId: input.eventId,
      category: "payments",
      senderUserId,
      senderEmail: sender.email,
      senderName: sender.name,
      urgent: input.kind === "payout_failed" || input.kind === "account_restricted" || input.kind === "payout_returned",
      // PropLane's own notice about the vendor's account: no workspace owns
      // it, so no manager's automation switch, template or draft-for-review
      // setting may mute, rewrite or hold it. The vendor's own notification
      // preferences and quiet hours still apply.
      systemNotice: proplaneSent,
      payload: { kind: input.kind },
      recipients,
    });
    return { sent: true };
  } catch (e) {
    console.error(`[vendor-banking] notification ${input.kind} failed:`, e instanceof Error ? e.message : e);
    return { sent: false, reason: "emit_failed" };
  }
}
