import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

const { purchaseMock, releaseMock, purchaseSkuMock } = vi.hoisted(() => ({
  purchaseMock: vi.fn(),
  releaseMock: vi.fn(async () => undefined),
  purchaseSkuMock: vi.fn(),
}));

vi.mock("@/lib/twilio-provisioning", () => ({
  purchaseManagerTwilioNumber: purchaseMock,
  releaseTwilioNumber: releaseMock,
}));

vi.mock("@/lib/manager-access-server", () => ({
  getManagerPurchaseSku: purchaseSkuMock,
}));

import {
  getManagerNumberRecord,
  provisionManagerNumber,
  resolveActiveManagerSendNumber,
  resolveManagerSendNumberState,
  setManagerRegistrationState,
} from "@/lib/sms/manager-number-provisioning.server";

const MGR = "mgr-1";

/** Actively-paid Pro on an admin grant — never trial, never date-expired. */
const PAID_SKU = {
  tier: "pro",
  billing: "admin",
  paidAt: null,
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  appleOriginalTransactionId: null,
  readFailed: false,
};

function seed() {
  return createMemoryDb({
    profiles: [{ id: MGR, email: "mgr@example.com", sms_from_number: null }],
    manager_sms_numbers: [],
  });
}

const origEnv = { ...process.env };
beforeEach(() => {
  purchaseMock.mockReset();
  releaseMock.mockReset();
  purchaseSkuMock.mockReset();
  purchaseSkuMock.mockResolvedValue(PAID_SKU);
  delete process.env.SMS_PROVISIONING_ENABLED;
  delete process.env.SMS_SHARED_REGISTRATION_STATE;
  // Most cases exercise the steady state: every actively-paid account enabled.
  process.env.SMS_PROVISIONING_ALLOWLIST = "*";
});
afterEach(() => {
  process.env = { ...origEnv };
});

describe("provisionManagerNumber — money guard parks pending", () => {
  it("parks in pending_registration and never buys when provisioning is disabled", async () => {
    const db = seed() as never;
    const res = await provisionManagerNumber(db, MGR);
    expect(res).toMatchObject({ ok: false, state: "pending_registration" });
    expect(purchaseMock).not.toHaveBeenCalled();
    const rec = await getManagerNumberRecord(db, MGR);
    expect(rec?.provisionState).toBe("pending_registration");
  });

  it("is idempotent while parked — re-running keeps one parked record, no purchase", async () => {
    const db = seed() as never;
    await provisionManagerNumber(db, MGR);
    await provisionManagerNumber(db, MGR);
    expect(purchaseMock).not.toHaveBeenCalled();
    expect((db as unknown as { __tables: Record<string, unknown[]> }).__tables.manager_sms_numbers).toHaveLength(1);
  });
});

describe("provisionManagerNumber — buys exactly one number when enabled", () => {
  it("provisions once and is idempotent on re-run (never a second number)", async () => {
    process.env.SMS_PROVISIONING_ENABLED = "1";
    purchaseMock.mockResolvedValue({ ok: true, number: "+12065550123", sid: "PN123", messagingServiceSid: "MG1" });
    const db = seed() as never;

    const first = await provisionManagerNumber(db, MGR);
    expect(first).toMatchObject({ ok: true, number: "+12065550123", alreadyProvisioned: false });
    expect(purchaseMock).toHaveBeenCalledTimes(1);

    const rec = await getManagerNumberRecord(db, MGR);
    expect(rec?.provisionState).toBe("active");
    expect(rec?.phoneNumberSid).toBe("PN123");
    expect(rec?.messagingServiceSid).toBe("MG1");
    const profiles = (db as unknown as { __tables: Record<string, Array<{ sms_from_number: string }>> }).__tables.profiles;
    expect(profiles[0]!.sms_from_number).toBe("+12065550123");

    const second = await provisionManagerNumber(db, MGR);
    expect(second).toMatchObject({ ok: true, alreadyProvisioned: true, number: "+12065550123" });
    expect(purchaseMock).toHaveBeenCalledTimes(1); // still one — no second buy
  });

  it("records a retryable failed state and bumps attempts on provider error", async () => {
    process.env.SMS_PROVISIONING_ENABLED = "1";
    purchaseMock.mockResolvedValue({ ok: false, error: "No SMS-capable numbers available." });
    const db = seed() as never;

    const res = await provisionManagerNumber(db, MGR);
    expect(res).toMatchObject({ ok: false, state: "failed" });
    const rec = await getManagerNumberRecord(db, MGR);
    expect(rec?.provisionState).toBe("failed");
    expect(rec?.attempts).toBe(1);
    expect(rec?.lastError).toContain("No SMS-capable");

    // A retry re-attempts (attempts increments), proving the state is retryable.
    await provisionManagerNumber(db, MGR);
    const rec2 = await getManagerNumberRecord(db, MGR);
    expect(rec2?.attempts).toBe(2);
  });
});

describe("provisionManagerNumber — paid entitlement + deliberate enablement", () => {
  it("never buys when the allowlist is unset (deliberate enablement required)", async () => {
    process.env.SMS_PROVISIONING_ENABLED = "1";
    delete process.env.SMS_PROVISIONING_ALLOWLIST;
    purchaseMock.mockResolvedValue({ ok: true, number: "+12065550123", sid: "PN1", messagingServiceSid: null });
    const db = seed() as never;
    const res = await provisionManagerNumber(db, MGR);
    expect(res).toMatchObject({ ok: false, error: "access:not_enabled", state: "pending_registration" });
    expect(purchaseMock).not.toHaveBeenCalled();
  });

  it("never buys for a trialing subscription — trial is not payment", async () => {
    process.env.SMS_PROVISIONING_ENABLED = "1";
    purchaseSkuMock.mockResolvedValue({
      ...PAID_SKU,
      billing: "monthly",
      stripeSubscriptionId: "sub_1",
      // Stripe trial runs 14 days from checkout; this checkout was yesterday.
      paidAt: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
    });
    const db = seed() as never;
    const res = await provisionManagerNumber(db, MGR);
    expect(res).toMatchObject({ ok: false, error: "access:trialing", state: "pending_registration" });
    expect(purchaseMock).not.toHaveBeenCalled();
  });

  it("never buys for a Free-tier account, and fails closed on an unreadable plan", async () => {
    process.env.SMS_PROVISIONING_ENABLED = "1";
    purchaseSkuMock.mockResolvedValue({ ...PAID_SKU, tier: "free", billing: "free" });
    const db = seed() as never;
    expect(await provisionManagerNumber(db, MGR)).toMatchObject({ ok: false, error: "access:not_paid_tier" });

    purchaseSkuMock.mockResolvedValue({ ...PAID_SKU, readFailed: true });
    expect(await provisionManagerNumber(db, MGR)).toMatchObject({ ok: false, error: "access:plan_unreadable" });
    expect(purchaseMock).not.toHaveBeenCalled();
  });

  it("a listed account is enabled deliberately, regardless of billing state", async () => {
    process.env.SMS_PROVISIONING_ENABLED = "1";
    process.env.SMS_PROVISIONING_ALLOWLIST = "mgr@example.com";
    purchaseSkuMock.mockResolvedValue({ ...PAID_SKU, tier: "free", billing: "free" });
    purchaseMock.mockResolvedValue({ ok: true, number: "+12065550321", sid: "PN3", messagingServiceSid: null });
    const db = seed() as never;
    const res = await provisionManagerNumber(db, MGR);
    expect(res).toMatchObject({ ok: true, number: "+12065550321" });
    expect(purchaseMock).toHaveBeenCalledTimes(1);
  });

  it("an unlisted account is refused while the list names someone else", async () => {
    process.env.SMS_PROVISIONING_ENABLED = "1";
    process.env.SMS_PROVISIONING_ALLOWLIST = "someone-else@example.com";
    const db = seed() as never;
    const res = await provisionManagerNumber(db, MGR);
    expect(res).toMatchObject({ ok: false, error: "access:not_enabled" });
    expect(purchaseMock).not.toHaveBeenCalled();
  });

  it("a retried signup provisions exactly once (idempotent under the paid gate)", async () => {
    process.env.SMS_PROVISIONING_ENABLED = "1";
    purchaseMock.mockResolvedValue({ ok: true, number: "+12065550456", sid: "PN4", messagingServiceSid: null });
    const db = seed() as never;
    // Signup fires the hook; a retried signup fires it again.
    await Promise.all([provisionManagerNumber(db, MGR), Promise.resolve()]);
    await provisionManagerNumber(db, MGR);
    expect(purchaseMock).toHaveBeenCalledTimes(1);
  });
});

describe("resolveActiveManagerSendNumber — downgrade suspends service", () => {
  it("a manager who downgrades to Free keeps the number but it stops sending", async () => {
    process.env.SMS_PROVISIONING_ENABLED = "1";
    process.env.SMS_SHARED_REGISTRATION_STATE = "approved";
    purchaseMock.mockResolvedValue({ ok: true, number: "+12065550888", sid: "PN8", messagingServiceSid: null });
    const db = seed() as never;
    await provisionManagerNumber(db, MGR);
    expect(await resolveActiveManagerSendNumber(db, MGR)).toBe("+12065550888");

    // Downgrade: the plan now resolves Free. Nothing releases the number…
    purchaseSkuMock.mockResolvedValue({ ...PAID_SKU, tier: "free", billing: "free" });
    expect(await resolveActiveManagerSendNumber(db, MGR)).toBeNull();
    const rec = await getManagerNumberRecord(db, MGR);
    expect(rec?.provisionState).toBe("active");
    expect(rec?.phoneNumber).toBe("+12065550888");

    // …an infra blip is NOT a downgrade — messaging keeps flowing…
    purchaseSkuMock.mockResolvedValue({ ...PAID_SKU, readFailed: true });
    expect(await resolveActiveManagerSendNumber(db, MGR)).toBe("+12065550888");

    // …and re-upgrading restores service with no other surgery.
    purchaseSkuMock.mockResolvedValue(PAID_SKU);
    expect(await resolveActiveManagerSendNumber(db, MGR)).toBe("+12065550888");
  });
});

describe("resolveManagerSendNumberState — suspended is not 'no number'", () => {
  it("names the suspension so callers cannot fall back onto the same number", async () => {
    process.env.SMS_PROVISIONING_ENABLED = "1";
    process.env.SMS_SHARED_REGISTRATION_STATE = "approved";
    purchaseMock.mockResolvedValue({ ok: true, number: "+12065550888", sid: "PN8", messagingServiceSid: null });
    const db = seed() as never;

    // No record yet → unavailable (a legacy manager may still have a stamped
    // profile number, so the caller's fallbacks stay live).
    expect(await resolveManagerSendNumberState(db, MGR)).toEqual({ status: "unavailable" });

    await provisionManagerNumber(db, MGR);
    expect(await resolveManagerSendNumberState(db, MGR)).toEqual({
      status: "ok",
      phoneNumber: "+12065550888",
    });

    purchaseSkuMock.mockResolvedValue({ ...PAID_SKU, tier: "free", billing: "free" });
    expect(await resolveManagerSendNumberState(db, MGR)).toEqual({
      status: "suspended",
      phoneNumber: "+12065550888",
    });
  });
});

describe("resolveActiveManagerSendNumber — registration gate", () => {
  it("returns the number only once the manager's registration is approved", async () => {
    process.env.SMS_PROVISIONING_ENABLED = "1";
    purchaseMock.mockResolvedValue({ ok: true, number: "+12065550999", sid: "PN9", messagingServiceSid: null });
    const db = seed() as never;
    await provisionManagerNumber(db, MGR);

    // Active number but registration still pending → cannot send yet.
    expect(await resolveActiveManagerSendNumber(db, MGR)).toBeNull();

    await setManagerRegistrationState(db, MGR, "approved");
    expect(await resolveActiveManagerSendNumber(db, MGR)).toBe("+12065550999");

    await setManagerRegistrationState(db, MGR, "rejected");
    expect(await resolveActiveManagerSendNumber(db, MGR)).toBeNull();
  });

  it("single shared registration: one env flip makes a shared-ref manager sendable, no per-row write", async () => {
    process.env.SMS_PROVISIONING_ENABLED = "1";
    purchaseMock.mockResolvedValue({ ok: true, number: "+12065550777", sid: "PN7", messagingServiceSid: null });
    const db = seed() as never;
    // Signup path seeds registration_ref = "shared" and never approves per-row.
    await provisionManagerNumber(db, MGR);
    expect(await resolveActiveManagerSendNumber(db, MGR)).toBeNull();

    process.env.SMS_SHARED_REGISTRATION_STATE = "approved";
    expect(await resolveActiveManagerSendNumber(db, MGR)).toBe("+12065550777");
  });
});
