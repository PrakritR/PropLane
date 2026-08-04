/**
 * 90-day suspended-number grace: stamp on unpaid detection, warn before
 * release, release past grace — and NEVER purchase a number from this path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

const { purchaseMock, releaseMock, purchaseSkuMock, bounceMock } = vi.hoisted(() => ({
  purchaseMock: vi.fn(),
  releaseMock: vi.fn(async () => undefined),
  purchaseSkuMock: vi.fn(),
  bounceMock: vi.fn(async () => ({ sent: true })),
}));

vi.mock("@/lib/twilio-provisioning", () => ({
  purchaseManagerTwilioNumber: purchaseMock,
  releaseTwilioNumber: releaseMock,
}));

vi.mock("@/lib/manager-access-server", () => ({
  getManagerPurchaseSku: purchaseSkuMock,
}));

vi.mock("@/lib/sms-inbox-notice.server", () => ({
  sendManagerNoticeEmail: bounceMock,
  upsertManagerInboxNotice: vi.fn(async () => undefined),
  notifyManagerOfInboundSms: vi.fn(async () => ({ inboxNoticeWritten: true, emailSent: false })),
  CO_MANAGER_SMS_EMAIL_PORTAL_ONLY_COPY: "portal-only",
}));

import {
  releaseExpiredSuspendedNumber,
  sweepSuspendedManagerNumbers,
} from "@/lib/sms/manager-number-suspension.server";
import { resolveManagerSendNumberState } from "@/lib/sms/manager-number-provisioning.server";
import {
  SMS_NUMBER_SUSPENSION_GRACE_DAYS,
  SMS_NUMBER_SUSPENSION_WARN_DAYS_BEFORE,
} from "@/lib/sms/number-registration-policy";

const MGR = "mgr-1";
const PHONE = "+12065550123";
const SID = "PN_TEST_SID";

const PAID_SKU = {
  tier: "pro",
  billing: "admin",
  paidAt: null,
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  appleOriginalTransactionId: null,
  readFailed: false,
};

const FREE_SKU = {
  tier: "free",
  billing: null,
  paidAt: null,
  stripeCustomerId: null,
  stripeSubscriptionId: null,
  appleOriginalTransactionId: null,
  readFailed: false,
};

function seed(overrides?: {
  serviceSuspendedAt?: string | null;
  suspensionWarnedAt?: string | null;
}) {
  return createMemoryDb({
    profiles: [{ id: MGR, email: "mgr@example.com", sms_from_number: PHONE }],
    manager_sms_numbers: [
      {
        manager_user_id: MGR,
        phone_number: PHONE,
        phone_number_sid: SID,
        provision_state: "active",
        registration_state: "approved",
        registration_ref: "shared",
        service_suspended_at: overrides?.serviceSuspendedAt ?? null,
        suspension_warned_at: overrides?.suspensionWarnedAt ?? null,
      },
    ],
  });
}

const origEnv = { ...process.env };
beforeEach(() => {
  purchaseMock.mockReset();
  releaseMock.mockReset();
  purchaseSkuMock.mockReset();
  bounceMock.mockReset();
  bounceMock.mockResolvedValue({ sent: true });
  process.env.SMS_PROVISIONING_ALLOWLIST = "*";
  process.env.SMS_SHARED_REGISTRATION_STATE = "approved";
  delete process.env.SMS_PROVISIONING_ENABLED;
});
afterEach(() => {
  process.env = { ...origEnv };
});

describe("resolveManagerSendNumberState — stamps / clears suspension", () => {
  it("stamps service_suspended_at the first time an unpaid send is refused", async () => {
    purchaseSkuMock.mockResolvedValue(FREE_SKU);
    const db = seed() as never;
    const state = await resolveManagerSendNumberState(db, MGR);
    expect(state.status).toBe("suspended");
    const row = (db as unknown as { __tables: Record<string, Array<Record<string, unknown>>> })
      .__tables.manager_sms_numbers[0]!;
    expect(row.service_suspended_at).toBeTruthy();
  });

  it("clears the stamp when the account is entitled again", async () => {
    purchaseSkuMock.mockResolvedValue(PAID_SKU);
    const db = seed({ serviceSuspendedAt: "2026-01-01T00:00:00.000Z" }) as never;
    const state = await resolveManagerSendNumberState(db, MGR);
    expect(state).toMatchObject({ status: "ok", phoneNumber: PHONE });
    const row = (db as unknown as { __tables: Record<string, Array<Record<string, unknown>>> })
      .__tables.manager_sms_numbers[0]!;
    expect(row.service_suspended_at).toBeNull();
    expect(row.suspension_warned_at).toBeNull();
  });
});

describe("sweepSuspendedManagerNumbers", () => {
  it("never calls purchaseManagerTwilioNumber", async () => {
    purchaseSkuMock.mockResolvedValue(FREE_SKU);
    const now = Date.parse("2026-08-04T12:00:00.000Z");
    const suspendedAt = new Date(
      now - SMS_NUMBER_SUSPENSION_GRACE_DAYS * 86_400_000,
    ).toISOString();
    const db = seed({ serviceSuspendedAt: suspendedAt }) as never;
    await sweepSuspendedManagerNumbers(db, { nowMs: now });
    expect(purchaseMock).not.toHaveBeenCalled();
  });

  it("warns once when inside the pre-release window", async () => {
    purchaseSkuMock.mockResolvedValue(FREE_SKU);
    const now = Date.parse("2026-08-04T12:00:00.000Z");
    const ageDays = SMS_NUMBER_SUSPENSION_GRACE_DAYS - SMS_NUMBER_SUSPENSION_WARN_DAYS_BEFORE;
    const suspendedAt = new Date(now - ageDays * 86_400_000).toISOString();
    const db = seed({ serviceSuspendedAt: suspendedAt }) as never;
    const result = await sweepSuspendedManagerNumbers(db, { nowMs: now });
    expect(result.warned).toBe(1);
    expect(result.released).toBe(0);
    expect(bounceMock).toHaveBeenCalledTimes(1);
    expect(String((bounceMock.mock.calls[0]![0] as { subject: string }).subject)).toMatch(
      /will be released/i,
    );
    expect(purchaseMock).not.toHaveBeenCalled();
  });

  it("releases past grace: Twilio release + profile clear + provision_state released", async () => {
    purchaseSkuMock.mockResolvedValue(FREE_SKU);
    const now = Date.parse("2026-08-04T12:00:00.000Z");
    const suspendedAt = new Date(
      now - (SMS_NUMBER_SUSPENSION_GRACE_DAYS + 1) * 86_400_000,
    ).toISOString();
    const db = seed({ serviceSuspendedAt: suspendedAt, suspensionWarnedAt: suspendedAt }) as never;
    const result = await sweepSuspendedManagerNumbers(db, { nowMs: now });
    expect(result.released).toBe(1);
    expect(releaseMock).toHaveBeenCalledWith(SID);
    expect(purchaseMock).not.toHaveBeenCalled();
    const tables = (db as unknown as { __tables: Record<string, Array<Record<string, unknown>>> })
      .__tables;
    expect(tables.manager_sms_numbers[0]!.provision_state).toBe("released");
    expect(tables.profiles[0]!.sms_from_number).toBeNull();
  });

  it("does not release a re-entitled account even if the stamp is past grace", async () => {
    purchaseSkuMock.mockResolvedValue(PAID_SKU);
    const now = Date.parse("2026-08-04T12:00:00.000Z");
    const suspendedAt = new Date(
      now - (SMS_NUMBER_SUSPENSION_GRACE_DAYS + 5) * 86_400_000,
    ).toISOString();
    const db = seed({ serviceSuspendedAt: suspendedAt }) as never;
    const result = await sweepSuspendedManagerNumbers(db, { nowMs: now });
    expect(result.released).toBe(0);
    expect(result.cleared).toBeGreaterThanOrEqual(1);
    expect(releaseMock).not.toHaveBeenCalled();
    expect(purchaseMock).not.toHaveBeenCalled();
  });
});

describe("releaseExpiredSuspendedNumber", () => {
  it("no-ops when the row is not suspended", async () => {
    const db = seed() as never;
    await releaseExpiredSuspendedNumber(db, MGR);
    expect(releaseMock).not.toHaveBeenCalled();
    expect(purchaseMock).not.toHaveBeenCalled();
  });
});
