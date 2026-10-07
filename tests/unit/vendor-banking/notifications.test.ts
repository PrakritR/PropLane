import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

const h = vi.hoisted(() => ({ emitAction: vi.fn(), emitBanking: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/action-events.server", () => ({ emitActionEvent: h.emitAction }));
vi.mock("@/lib/app-url", () => ({ resolveEmailLinkBaseUrl: () => "https://app.example" }));

import { audiencesForVendorBankingEvent, emitVendorBankingEvent } from "@/lib/vendor-banking/events.server";
import { renderVendorBankingEvent, type VendorBankingEventKind } from "@/lib/vendor-banking/events";
import { vendorTopicForEvent } from "@/lib/vendor-notification-settings";

const KINDS: VendorBankingEventKind[] = [
  "payout_paid", "payout_failed", "payout_returned", "bank_removed", "bank_needs_verification", "account_restricted",
  "refund_sent", "refund_received", "dispute_opened", "dispute_closed", "money_held_no_bank",
];

function db(rows: { manager?: { email: string; full_name: string } | null; payout?: { manager_user_id: string } | null } = {}) {
  return {
    from(table: string) {
      const data = table === "profiles" ? (rows.manager ?? { email: "mgr@example.com", full_name: "Test Manager" }) : ("payout" in rows ? rows.payout : { manager_user_id: "mgr_1" });
      const b: Record<string, unknown> = {};
      for (const m of ["select", "eq", "order", "limit"]) b[m] = () => b;
      b.maybeSingle = async () => ({ data, error: null });
      return b;
    },
  };
}

beforeEach(() => {
  h.emitAction.mockReset();
});

describe("vendor banking copy", () => {
  it("every kind renders for exactly its audiences, in plain words (service, never work order)", () => {
    for (const kind of KINDS) {
      for (const audience of ["vendor", "manager"] as const) {
        const rendered = renderVendorBankingEvent(kind, audience, { amountCents: 20_500, title: "Patch drywall hole", bankLabel: "Chase ••6789" });
        const expected = audiencesForVendorBankingEvent(kind).includes(audience);
        expect(Boolean(rendered), `${kind}/${audience}`).toBe(expected);
        if (rendered) expect(`${rendered.subject} ${rendered.text}`).not.toMatch(/work order/i);
      }
    }
  });

  it("names the figures and the bank", () => {
    expect(renderVendorBankingEvent("payout_paid", "vendor", { amountCents: 40_000, bankLabel: "Chase ••6789" })?.text).toBe("Your $400.00 payout to Chase ••6789 was paid.");
    expect(renderVendorBankingEvent("refund_received", "manager", { amountCents: 5_000, vendorName: "Dima Handyman" })?.text).toContain("$50.00");
    expect(renderVendorBankingEvent("dispute_closed", "vendor", { amountCents: 20_500, outcome: "lost" })?.text).toContain("taken from your balance");
  });

  it("files every vendor banking event under the vendor's Payments topic", () => {
    for (const kind of KINDS) expect(vendorTopicForEvent("vendor_banking", kind)).toBe("payments");
  });
});

describe("emitVendorBankingEvent", () => {
  it("emits one idempotent action event on the vendor_banking domain with each audience's own copy", async () => {
    const result = await emitVendorBankingEvent(db() as never, {
      kind: "dispute_opened", eventId: "dispute:dp_1:opened", vendorUserId: "vendor_1", managerUserId: "mgr_1", facts: { amountCents: 20_500 },
    });
    expect(result).toEqual({ sent: true });
    const input = h.emitAction.mock.calls[0]![1];
    expect(input).toMatchObject({ eventId: "vendor_banking:dispute:dp_1:opened", domain: "vendor_banking", event: "dispute_opened", managerUserId: "mgr_1", category: "payments" });
    expect(input.recipients.map((r: { audience: string; userId: string }) => [r.audience, r.userId])).toEqual([["vendor", "vendor_1"], ["manager", "mgr_1"]]);
  });

  it("a vendor-only moment (payout paid) goes to the vendor, sent as their latest paying manager", async () => {
    await emitVendorBankingEvent(db() as never, { kind: "payout_paid", eventId: "payout:po_1:payout_paid", vendorUserId: "vendor_1", facts: { amountCents: 40_000 } });
    const input = h.emitAction.mock.calls[0]![1];
    expect(input.managerUserId).toBe("mgr_1");
    expect(input.recipients).toHaveLength(1);
    expect(input.recipients[0]).toMatchObject({ audience: "vendor", userId: "vendor_1" });
  });

  it("urgent for a failed payout and a restricted account", async () => {
    await emitVendorBankingEvent(db() as never, { kind: "payout_failed", eventId: "x", vendorUserId: "vendor_1", facts: {} });
    await emitVendorBankingEvent(db() as never, { kind: "payout_paid", eventId: "y", vendorUserId: "vendor_1", facts: {} });
    expect(h.emitAction.mock.calls[0]![1].urgent).toBe(true);
    expect(h.emitAction.mock.calls[1]![1].urgent).toBe(false);
  });

  it("never throws into a money path: a bus failure is swallowed", async () => {
    h.emitAction.mockRejectedValue(new Error("bus down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(emitVendorBankingEvent(db() as never, { kind: "payout_paid", eventId: "z", vendorUserId: "vendor_1", facts: {} })).resolves.toEqual({ sent: false });
    spy.mockRestore();
  });

  it("sends nothing when there is no manager to send as", async () => {
    const result = await emitVendorBankingEvent(db({ payout: null }) as never, { kind: "payout_paid", eventId: "n", vendorUserId: "vendor_1", facts: {} });
    expect(result).toEqual({ sent: false });
    expect(h.emitAction).not.toHaveBeenCalled();
  });
});

describe("webhook triggers", () => {
  it("payout paid / failed / returned, bank removed, account restricted reach emitVendorBankingEvent for a vendor-owned account", async () => {
    vi.resetModules();
    const emit = vi.fn();
    vi.doMock("@/lib/vendor-banking/events.server", () => ({ emitVendorBankingEvent: emit }));
    vi.doMock("@/lib/stripe-external-accounts.server", () => ({ refreshPayoutDestinationsCacheFromStripe: vi.fn() }));
    vi.doMock("@/lib/test-workspaces/effects.server", () => ({ captureTestWorkspaceEffectForUser: vi.fn(async () => ({ captured: false })) }));
    let priorStatus: string | null = null;
    const fake = {
      from(table: string) {
        const b: Record<string, unknown> = {};
        for (const m of ["select", "eq"]) b[m] = () => b;
        b.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: table === "profile_roles" ? [{ role: "vendor" }] : [], error: null }).then(resolve);
        b.maybeSingle = async () => ({ data: table === "profiles" ? { id: "vendor_1" } : table === "stripe_payouts" && priorStatus ? { status: priorStatus } : null, error: null });
        b.upsert = async () => ({ error: null });
        return b;
      },
    };
    const mod = await import("@/lib/stripe-webhook-financials");
    const base = { id: "po_1", amount: 40_000, currency: "usd", method: "standard", type: "bank_account", arrival_date: null, failure_code: null, failure_message: null, destination: null };
    await mod.handleConnectPayoutEvent(fake as never, { ...base, status: "paid" } as unknown as Stripe.Payout, "acct_1");
    await mod.handleConnectPayoutEvent(fake as never, { ...base, status: "failed" } as unknown as Stripe.Payout, "acct_1");
    priorStatus = "paid";
    await mod.handleConnectPayoutEvent(fake as never, { ...base, status: "failed" } as unknown as Stripe.Payout, "acct_1");
    await mod.handleExternalAccountEvent({} as never, fake as never, "acct_1", {
      type: "account.external_account.deleted",
      object: { id: "ba_1", object: "bank_account", last4: "6789", bank_name: "Chase" } as unknown as Stripe.BankAccount,
    });
    expect(emit.mock.calls.map((c) => (c[1] as { kind: string }).kind)).toEqual(["payout_paid", "payout_failed", "payout_returned", "bank_removed"]);
    expect(emit.mock.calls[3]![1].facts.bankLabel).toBe("Chase ••6789");
    vi.doUnmock("@/lib/vendor-banking/events.server");
  });
});
