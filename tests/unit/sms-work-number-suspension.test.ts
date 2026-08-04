/**
 * Suspension has to bite where the from-number is CHOSEN, not only where it is
 * sent: a suspended manager still owns that number, so every fallback in
 * `sendFromManagerWorkNumber` resolves to the same one. Plus the owner+access
 * lookup's per-send cost bound (it runs on every outbound).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendNumberStateMock, ensureNumberMock, sendSmsMock, purchaseSkuMock } = vi.hoisted(() => ({
  sendNumberStateMock: vi.fn(),
  ensureNumberMock: vi.fn(async () => ({ ok: true as const, number: "+12065550111" })),
  sendSmsMock: vi.fn(async () => ({ sent: true as const, sid: "SM1" })),
  purchaseSkuMock: vi.fn(),
}));

vi.mock("@/lib/claw-messenger.server", () => ({
  isClawMessengerConfigured: () => false,
  normalizeE164Us: (x: string) => x,
  registerClawMessengerRoute: vi.fn(async () => undefined),
  sendClawMessengerText: vi.fn(async () => ({ ok: false as const, error: "off" })),
}));
vi.mock("@/lib/claw-leasing-links", () => ({
  clawLeasingAgentPhoneE164: () => "+12053690702",
  isClawSharedLineBridgeEnabled: () => false,
  isLegacyClawSharedSmsNumber: () => false,
  managerContactSmsPhoneForPublicCta: (x: string | null) => x ?? null,
}));
vi.mock("@/lib/sms-consent", () => ({ isPhoneOptedOut: vi.fn(async () => false) }));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: () => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.in = () => chain;
      chain.limit = async () => ({ data: [] });
      // Legacy fallback read: no stamped number on the profile.
      chain.maybeSingle = async () => ({ data: { sms_from_number: null } });
      return chain;
    },
  }),
}));
vi.mock("@/lib/twilio", () => ({ normalizeE164: (x: string) => x, sendSms: sendSmsMock }));
vi.mock("@/lib/sms/manager-number-provisioning.server", () => ({
  resolveManagerSendNumberState: sendNumberStateMock,
}));
vi.mock("@/lib/twilio-provisioning", () => ({ ensureManagerSmsNumber: ensureNumberMock }));
vi.mock("@/lib/manager-access-server", () => ({ getManagerPurchaseSku: purchaseSkuMock }));

import { sendFromManagerWorkNumber } from "@/lib/proplane-sms-transport.server";
import {
  clearWorkNumberOwnerAccessCache,
  resolveManagerNumberAccess,
  resolveWorkNumberOwnerAccess,
  sendAllowedByAccess,
} from "@/lib/sms/manager-number-access.server";

const MGR = "mgr-1";
const WORK_NUMBER = "+12065550100";

const origEnv = { ...process.env };
beforeEach(() => {
  sendNumberStateMock.mockReset();
  ensureNumberMock.mockClear();
  sendSmsMock.mockClear();
  purchaseSkuMock.mockReset();
  purchaseSkuMock.mockResolvedValue({
    tier: "pro",
    billing: "admin",
    paidAt: null,
    stripeSubscriptionId: null,
    readFailed: false,
  });
  clearWorkNumberOwnerAccessCache();
  process.env = { ...origEnv, SMS_PROVISIONING_ALLOWLIST: "*" };
});

describe("sendFromManagerWorkNumber — a suspended number never falls back to itself", () => {
  it("refuses with number_suspended instead of re-reading profiles or buying one", async () => {
    sendNumberStateMock.mockResolvedValue({ status: "suspended", phoneNumber: WORK_NUMBER });
    const res = await sendFromManagerWorkNumber({ managerUserId: MGR, to: "+14255550123", text: "hi" });
    expect(res).toMatchObject({ ok: false, error: "number_suspended" });
    expect(sendSmsMock).not.toHaveBeenCalled();
    // Buying a number as a side effect of a suspended send would be the worst
    // possible fallback — the account is not paying for one.
    expect(ensureNumberMock).not.toHaveBeenCalled();
  });

  it("still sends for a manager whose own number is approved", async () => {
    sendNumberStateMock.mockResolvedValue({ status: "ok", phoneNumber: WORK_NUMBER });
    const res = await sendFromManagerWorkNumber({ managerUserId: MGR, to: "+14255550123", text: "hi" });
    expect(res).toMatchObject({ ok: true, channel: "twilio" });
    expect(sendSmsMock.mock.calls[0]![2]).toBe(WORK_NUMBER);
  });

  it("keeps the legacy fallback for a manager with no number record", async () => {
    sendNumberStateMock.mockResolvedValue({ status: "unavailable" });
    const res = await sendFromManagerWorkNumber({ managerUserId: MGR, to: "+14255550123", text: "hi" });
    expect(res.ok).toBe(true);
    expect(ensureNumberMock).toHaveBeenCalledTimes(1);
  });
});

describe("resolveWorkNumberOwnerAccess — bounded per-send cost", () => {
  function countingDb(): { db: unknown; profileReads: () => number } {
    let profileReads = 0;
    const db = {
      from: (table: string) => {
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.in = () => chain;
        chain.eq = () => chain;
        chain.limit = async () => {
          if (table === "profiles") profileReads += 1;
          return { data: [{ id: MGR }] };
        };
        chain.maybeSingle = async () => ({ data: { id: MGR, email: "m@example.com" } });
        return chain;
      },
    };
    return { db, profileReads: () => profileReads };
  }

  it("memoizes the owner+access decision so a fan-out pays it once", async () => {
    const { db, profileReads } = countingDb();
    const first = await resolveWorkNumberOwnerAccess(db as never, WORK_NUMBER);
    expect(first).toMatchObject({ managerUserId: MGR });
    for (let i = 0; i < 10; i += 1) {
      await resolveWorkNumberOwnerAccess(db as never, WORK_NUMBER);
    }
    expect(profileReads()).toBe(1);
    expect(purchaseSkuMock).toHaveBeenCalledTimes(1);
    // Different storage formats of one number are the same cache entry.
    await resolveWorkNumberOwnerAccess(db as never, "(206) 555-0100");
    expect(profileReads()).toBe(1);
  });

  it("re-reads after the cache is dropped, so the memo is never the authority", async () => {
    const { db, profileReads } = countingDb();
    await resolveWorkNumberOwnerAccess(db as never, WORK_NUMBER);
    clearWorkNumberOwnerAccessCache();
    await resolveWorkNumberOwnerAccess(db as never, WORK_NUMBER);
    expect(profileReads()).toBe(2);
  });

  it("never memoizes a failed read — that is a blip, not 'this number has no owner'", async () => {
    let reads = 0;
    const failing = {
      from: () => {
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.in = () => chain;
        chain.eq = () => chain;
        chain.limit = async () => {
          reads += 1;
          return { data: null, error: { message: "connection reset" } };
        };
        chain.maybeSingle = async () => ({ data: null, error: { message: "connection reset" } });
        return chain;
      },
    };
    expect(await resolveWorkNumberOwnerAccess(failing as never, WORK_NUMBER)).toBeNull();
    expect(await resolveWorkNumberOwnerAccess(failing as never, WORK_NUMBER)).toBeNull();
    expect(reads).toBe(2);
  });
});

describe("resolveManagerNumberAccess — list mode fails open on an unreadable profile", () => {
  it("reports plan_unreadable, not a definitive not_enabled, when the email cannot be read", async () => {
    process.env.SMS_PROVISIONING_ALLOWLIST = "pilot@example.com";
    const failing = {
      from: () => {
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.eq = () => chain;
        chain.in = () => chain;
        chain.limit = async () => ({ data: null, error: { message: "connection reset" } });
        chain.maybeSingle = async () => ({ data: null, error: { message: "connection reset" } });
        return chain;
      },
    };
    const decision = await resolveManagerNumberAccess(failing as never, MGR);
    expect(decision).toMatchObject({ allowed: false, reason: "plan_unreadable" });
    // The send path keeps flowing on that reason; only the purchase path stops.
    expect(sendAllowedByAccess(decision)).toBe(true);
  });

  it("still refuses an account the captain has not enabled", async () => {
    process.env.SMS_PROVISIONING_ALLOWLIST = "pilot@example.com";
    const db = {
      from: () => {
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.eq = () => chain;
        chain.maybeSingle = async () => ({ data: { email: "someone@example.com" }, error: null });
        return chain;
      },
    };
    const decision = await resolveManagerNumberAccess(db as never, MGR);
    expect(decision).toMatchObject({ allowed: false, reason: "not_enabled" });
    expect(sendAllowedByAccess(decision)).toBe(false);
  });
});
