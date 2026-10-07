import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";

const h = vi.hoisted(() => ({ emitAction: vi.fn(), emitBanking: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@/lib/action-events.server", () => ({ emitActionEvent: h.emitAction }));
vi.mock("@/lib/app-url", () => ({ resolveEmailLinkBaseUrl: () => "https://app.example" }));

import { audiencesForVendorBankingEvent, emitVendorBankingEvent } from "@/lib/vendor-banking/events.server";
import { renderVendorBankingEvent, type VendorBankingEventKind } from "@/lib/vendor-banking/events";
import { vendorTopicForEvent } from "@/lib/vendor-notification-settings";
import { PRIMARY_ADMIN_EMAIL } from "@/lib/auth/primary-admin";

const KINDS: VendorBankingEventKind[] = [
  "payout_paid", "payout_failed", "payout_returned", "bank_removed", "bank_needs_verification", "account_restricted",
  "refund_sent", "refund_received", "dispute_opened", "dispute_closed", "money_held_no_bank",
];

/**
 * The PropLane ops profile exists by default — production always provisions it
 * (`scripts/ensure-admin-account.mjs`). `proplaneOps: false` is the
 * misconfigured database, where a PropLane notice must refuse rather than
 * borrow a manager's identity. `_tablesRead` proves which tables were consulted.
 */
function db(
  rows: {
    manager?: { email: string; full_name: string } | null;
    payout?: { manager_user_id: string } | null;
    proplaneOps?: boolean;
  } = {},
) {
  const tablesRead: string[] = [];
  const hasProplaneOps = rows.proplaneOps !== false;
  return {
    _tablesRead: tablesRead,
    from(table: string) {
      tablesRead.push(table);
      const b: Record<string, unknown> = {};
      let byEmail = "";
      b.select = () => b;
      b.eq = (col: string, value: unknown) => {
        if (col === "email") byEmail = String(value).trim().toLowerCase();
        return b;
      };
      b.order = () => b;
      b.limit = () => b;
      const one = () => {
        if (table !== "profiles") return "payout" in rows ? rows.payout : { manager_user_id: "mgr_1" };
        if (byEmail === PRIMARY_ADMIN_EMAIL.toLowerCase()) {
          return hasProplaneOps ? { id: "proplane_ops", email: PRIMARY_ADMIN_EMAIL, full_name: "PropLane" } : null;
        }
        return rows.manager ?? { id: "mgr_1", email: "mgr@example.com", full_name: "Test Manager" };
      };
      b.maybeSingle = async () => ({ data: one(), error: null });
      // `.limit(1)` without `.maybeSingle()` resolves to ROWS — the shape the
      // PropLane sender lookup reads, so two matching profiles cannot error.
      b.then = (resolve: (v: unknown) => unknown) => {
        const row = one();
        return Promise.resolve({ data: row ? [row] : [], error: null }).then(resolve);
      };
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

  it("a vendor-only moment (payout paid) goes to the vendor as a PropLane notice, never in a manager's name", async () => {
    await emitVendorBankingEvent(db() as never, { kind: "payout_paid", eventId: "payout:po_1:payout_paid", vendorUserId: "vendor_1", facts: { amountCents: 40_000 } });
    const input = h.emitAction.mock.calls[0]![1];
    expect(input.senderUserId).toBe("proplane_ops");
    expect(input.senderName).toBe("PropLane");
    expect(input.recipients).toHaveLength(1);
    expect(input.recipients[0]).toMatchObject({ audience: "vendor", userId: "vendor_1" });
  });

  it("every PropLane-sent kind rides as a system notice, so no workspace's automation settings can mute or hold it", async () => {
    const proplaneSent: VendorBankingEventKind[] = [
      "payout_paid", "payout_failed", "payout_returned", "bank_removed",
      "bank_needs_verification", "account_restricted", "money_held_no_bank",
    ];
    for (const kind of proplaneSent) {
      h.emitAction.mockReset();
      await emitVendorBankingEvent(db() as never, { kind, eventId: `e:${kind}`, vendorUserId: "vendor_1", facts: { amountCents: 1_000 } });
      const input = h.emitAction.mock.calls[0]![1];
      expect(input.systemNotice, kind).toBe(true);
      expect(input.senderUserId, kind).toBe("proplane_ops");
      expect(input.senderName, kind).toBe("PropLane");
      expect(input.recipients.every((r: { draftForReview?: boolean }) => r.draftForReview !== true), kind).toBe(true);
    }
  });

  it("a cross-party notice keeps the real manager id and stays on the manager-automation rail", async () => {
    await emitVendorBankingEvent(db({ proplaneOps: true }) as never, {
      kind: "dispute_opened", eventId: "dispute:dp_2:opened", vendorUserId: "vendor_1", managerUserId: "mgr_1", facts: { amountCents: 20_500 },
    });
    const input = h.emitAction.mock.calls[0]![1];
    expect(input.managerUserId).toBe("mgr_1");
    expect(input.systemNotice).toBe(false);
  });

  it("goes out under PropLane's own identity, never a manager's: address, name and sender id all the ops account", async () => {
    await emitVendorBankingEvent(db() as never, { kind: "payout_paid", eventId: "proplane", vendorUserId: "vendor_1", facts: {} });
    const input = h.emitAction.mock.calls[0]![1];
    expect(input.systemNotice).toBe(true);
    expect(input.senderUserId).toBe("proplane_ops");
    expect(input.managerUserId).toBe("proplane_ops");
    expect(input.senderEmail).toBe(PRIMARY_ADMIN_EMAIL.toLowerCase());
    expect(input.senderName).toBe("PropLane");
    expect(input.recipients.map((r: { audience: string; userId: string }) => [r.audience, r.userId])).toEqual([["vendor", "vendor_1"]]);
  });

  it("refuses rather than downgrading to a manager when the ops account is missing — a misconfiguration, not a fallback", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    // A paying manager IS available here; it must still not be used.
    const fake = db({ proplaneOps: false });
    const result = await emitVendorBankingEvent(fake as never, {
      kind: "account_restricted", eventId: "no-ops", vendorUserId: "vendor_1", facts: { reason: "requirements past due" },
    });
    expect(result).toEqual({ sent: false, reason: "proplane_sender_missing" });
    expect(h.emitAction).not.toHaveBeenCalled();
    expect(fake._tablesRead).not.toContain("vendor_payouts");
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("reaches a vendor with no payout history at all — PropLane is the sender, so there is nobody to be missing", async () => {
    const fake = db({ payout: null });
    const result = await emitVendorBankingEvent(fake as never, {
      kind: "account_restricted", eventId: "account:acct_1:restricted", vendorUserId: "vendor_1", facts: { reason: "requirements past due" },
    });
    expect(result).toEqual({ sent: true });
    const input = h.emitAction.mock.calls[0]![1];
    expect(input.senderUserId).toBe("proplane_ops");
    expect(fake._tablesRead).not.toContain("vendor_payouts");
    expect(input.recipients.map((r: { audience: string; userId: string }) => [r.audience, r.userId])).toEqual([["vendor", "vendor_1"]]);
  });

  it("a cross-party moment stays in the manager's name even when the PropLane identity exists", async () => {
    await emitVendorBankingEvent(db({ proplaneOps: true }) as never, {
      kind: "refund_sent", eventId: "refund:re_1:sent", vendorUserId: "vendor_1", managerUserId: "mgr_1", facts: { amountCents: 5_000 },
    });
    const input = h.emitAction.mock.calls[0]![1];
    expect(input.senderUserId).toBe("mgr_1");
    expect(input.senderEmail).toBe("mgr@example.com");
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
    await expect(emitVendorBankingEvent(db() as never, { kind: "payout_paid", eventId: "z", vendorUserId: "vendor_1", facts: {} }))
      .resolves.toEqual({ sent: false, reason: "emit_failed" });
    spy.mockRestore();
  });

  it("a cross-party moment with no manager to send as is dropped loudly, never in silence", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const result = await emitVendorBankingEvent(db({ payout: null }) as never, { kind: "refund_sent", eventId: "n", vendorUserId: "vendor_1", facts: {} });
    expect(result).toEqual({ sent: false, reason: "no_manager_sender" });
    expect(h.emitAction).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
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
