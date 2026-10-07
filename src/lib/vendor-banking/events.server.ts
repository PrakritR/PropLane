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

/** PropLane's own ops identity, the sender of a PropLane system notice. Null when the account is absent. */
async function proplaneSystemSender(
  db: SupabaseClient,
): Promise<{ userId: string; email: string; name: string } | null> {
  const { data } = await db
    .from("profiles")
    .select("id, email")
    .eq("email", PRIMARY_ADMIN_EMAIL.trim().toLowerCase())
    .maybeSingle();
  const userId = String((data as { id?: string } | null)?.id ?? "").trim();
  const email = String((data as { email?: string } | null)?.email ?? "").trim().toLowerCase();
  return userId && email ? { userId, email, name: "PropLane" } : null;
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
): Promise<{ sent: boolean }> {
  try {
    // A PropLane-sent kind goes out as PropLane. Only if that identity is
    // missing does it fall back to the manager rail, so the notice still lands.
    const system = PROPLANE_SENT_KINDS.has(input.kind) ? await proplaneSystemSender(db) : null;
    let sender: { userId: string; email: string; name?: string } | null = system;
    if (!sender) {
      const managerUserId = input.managerUserId ?? (await latestPayingManagerId(db, input.vendorUserId));
      const contact = managerUserId ? await profileContact(db, managerUserId) : null;
      if (!managerUserId || !contact?.email) {
        console.error(
          `[vendor-banking] notification ${input.kind} dropped: no sender for vendor ${input.vendorUserId}`,
        );
        return { sent: false };
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
    if (recipients.length === 0) return { sent: false };
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
      payload: { kind: input.kind },
      recipients,
    });
    return { sent: true };
  } catch (e) {
    console.error(`[vendor-banking] notification ${input.kind} failed:`, e instanceof Error ? e.message : e);
    return { sent: false };
  }
}
