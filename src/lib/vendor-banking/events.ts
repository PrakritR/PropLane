import type { ActionEventAudience } from "@/lib/action-events.server";

export type VendorBankingEventKind =
  | "payout_paid"
  | "payout_failed"
  | "payout_returned"
  | "bank_removed"
  | "bank_needs_verification"
  | "account_restricted"
  | "refund_sent"
  | "refund_received"
  | "dispute_opened"
  | "dispute_closed"
  | "money_held_no_bank";

export type VendorBankingEventFacts = {
  amountCents?: number;
  /** Bank label, e.g. "Chase ••6789". */
  bankLabel?: string;
  /** The service or invoice the money is about. */
  title?: string;
  vendorName?: string;
  managerName?: string;
  reason?: string;
  /** "won" | "lost" | "warning_closed" on a closed dispute. */
  outcome?: string;
};

function money(cents: number | undefined): string {
  return typeof cents === "number" ? `$${(cents / 100).toFixed(2)}` : "the amount";
}

/** Pure copy for every vendor banking moment. "Service", never "work order". */
export function renderVendorBankingEvent(
  kind: VendorBankingEventKind,
  audience: ActionEventAudience,
  facts: VendorBankingEventFacts,
): { subject: string; text: string; smsText: string } | null {
  const amount = money(facts.amountCents);
  const bank = facts.bankLabel?.trim() ? ` to ${facts.bankLabel.trim()}` : "";
  const about = facts.title?.trim() ? ` for “${facts.title.trim()}”` : "";
  const vendor = facts.vendorName?.trim() || "Your vendor";
  const manager = facts.managerName?.trim() || "the manager";
  let text: string | null = null;
  let subject = "Payments";
  if (audience === "vendor") {
    if (kind === "payout_paid") { subject = "Payout sent"; text = `Your ${amount} payout${bank} was paid.`; }
    if (kind === "payout_failed") { subject = "Payout failed"; text = `Your ${amount} payout${bank} failed${facts.reason ? `: ${facts.reason}` : ""}. The money is back in your balance.`; }
    if (kind === "payout_returned") { subject = "Payout returned"; text = `Your ${amount} payout${bank} was returned by the bank. The money is back in your balance.`; }
    if (kind === "bank_removed") { subject = "Bank removed"; text = `${facts.bankLabel?.trim() || "A bank account"} was removed. Add a bank to withdraw your balance.`; }
    if (kind === "bank_needs_verification") { subject = "Verify your bank"; text = `${facts.bankLabel?.trim() || "Your bank account"} needs verification before you can withdraw.`; }
    if (kind === "account_restricted") { subject = "Payments restricted"; text = `Payouts are paused on your account${facts.reason ? ` (${facts.reason})` : ""}. Open Finances to finish what is missing.`; }
    if (kind === "refund_sent") { subject = "Refund sent"; text = `You refunded ${amount}${about} to ${manager}.`; }
    if (kind === "dispute_opened") { subject = "Payment disputed"; text = `${manager} disputed a ${amount} payment${about}. That amount is frozen until the dispute closes.`; }
    if (kind === "dispute_closed") {
      subject = "Dispute closed";
      text = facts.outcome === "lost"
        ? `The ${amount} dispute${about} was decided against the payment. The amount was taken from your balance.`
        : `The ${amount} dispute${about} closed in your favor. The amount is released.`;
    }
    if (kind === "money_held_no_bank") { subject = "Money is waiting"; text = `${amount}${about} is held for you. Add a bank account and it is released to you.`; }
  }
  if (audience === "manager") {
    if (kind === "refund_received") { subject = "Refund received"; text = `${vendor} refunded ${amount}${about}. It is back in your books.`; }
    if (kind === "dispute_opened") { subject = "Payment disputed"; text = `A ${amount} payment${about} to ${vendor} was disputed.`; }
    if (kind === "dispute_closed") {
      subject = "Dispute closed";
      text = facts.outcome === "lost"
        ? `The ${amount} dispute${about} with ${vendor} closed against the payment.`
        : `The ${amount} dispute${about} with ${vendor} closed in favor of the payment.`;
    }
  }
  return text ? { subject: `${subject} · PropLane`, text, smsText: text } : null;
}
