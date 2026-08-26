import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

const { purchaseMock, releaseMock, findByRequestMock, listAttachedMock } = vi.hoisted(() => ({
  purchaseMock: vi.fn(),
  releaseMock: vi.fn(async () => undefined),
  findByRequestMock: vi.fn(),
  listAttachedMock: vi.fn(),
}));

vi.mock("@/lib/twilio-provisioning", () => ({
  purchaseManagerTwilioNumber: purchaseMock,
  releaseTwilioNumber: releaseMock,
  findManagerTwilioNumberByRequestId: findByRequestMock,
  listAttachedTwilioNumbers: listAttachedMock,
}));

import {
  getManagerNumberRecord,
  provisionManagerNumber,
  reconcilePendingManagerNumberOperations,
  resolveActiveManagerSendNumber,
  setManagerRegistrationState,
} from "@/lib/sms/manager-number-provisioning.server";

const MGR = "00000000-0000-4000-8000-000000000001";

function seed() {
  const db = createMemoryDb({
    profiles: [{ id: MGR, sms_from_number: null }],
    manager_sms_numbers: [],
  });
  Object.assign(db, {
    rpc: vi.fn(async (name: string, params: Record<string, string>) => {
      if (name !== "claim_manager_sms_provisioning") return { data: null, error: null };
      const rows = (db as unknown as { __tables: Record<string, Array<Record<string, unknown>>> }).__tables
        .manager_sms_numbers;
      const row = rows.find((candidate) => candidate.manager_user_id === params.p_manager_user_id);
      if (!row || !["pending_registration", "failed"].includes(String(row.provision_state))) {
        return { data: false, error: null };
      }
      row.provision_state = "provisioning";
      row.provision_request_id = params.p_request_id;
      row.attachment_state = "attaching";
      row.attempts = Number(row.attempts ?? 0) + 1;
      row.last_error = null;
      row.updated_at = new Date().toISOString();
      return { data: true, error: null };
    }),
  });
  return db;
}

async function markCarrierRegistered(db: ReturnType<typeof seed>) {
  await db
    .from("manager_sms_numbers")
    .update({
      provision_state: "active",
      attachment_state: "attached",
      number_registration_state: "registered",
    })
    .eq("manager_user_id", MGR);
}

const origEnv = { ...process.env };
beforeEach(() => {
  purchaseMock.mockReset();
  releaseMock.mockReset();
  findByRequestMock.mockReset();
  listAttachedMock.mockReset();
  delete process.env.SMS_PROVISIONING_ENABLED;
  delete process.env.SMS_SHARED_REGISTRATION_STATE;
});
afterEach(() => {
  process.env = { ...origEnv };
});

describe("reconcilePendingManagerNumberOperations — carrier registration", () => {
  it("quarantines attached provisioning numbers when carrier progress is stale even if updated_at is recent", async () => {
    process.env.SMS_PROVISIONING_ENABLED = "1";
    const now = Date.now();
    const db = createMemoryDb({
      manager_sms_numbers: [
        {
          manager_user_id: MGR,
          phone_number: "+12065550123",
          phone_number_sid: "PN123",
          provision_state: "provisioning",
          attachment_state: "attached",
          number_registration_state: "pending",
          registration_submitted_at: new Date(now - 31 * 60_000).toISOString(),
          last_provider_event_at: null,
          provider_reconciled_at: null,
          quarantined_at: null,
          quarantine_reason: null,
          updated_at: new Date(now - 60_000).toISOString(),
        },
      ],
    });
    listAttachedMock.mockResolvedValue({
      ok: true,
      phoneNumbers: new Set(["+12065550123"]),
    });

    const result = await reconcilePendingManagerNumberOperations(db as never);

    expect(result).toMatchObject({
      attachmentChecked: 1,
      attachmentDrifted: 0,
      needsReview: 1,
    });
    expect(db.__tables.manager_sms_numbers[0]).toMatchObject({
      quarantine_reason: "carrier_registration_stale",
      last_error:
        "Carrier registration has not reported progress; operator review is required.",
    });
    expect(db.__tables.manager_sms_numbers[0]?.quarantined_at).toEqual(
      expect.any(String),
    );
  });

  it("does not refresh updated_at or quarantine while carrier progress is fresh", async () => {
    process.env.SMS_PROVISIONING_ENABLED = "1";
    const now = Date.now();
    const lifecycleUpdatedAt = new Date(now - 2 * 60 * 60_000).toISOString();
    const db = createMemoryDb({
      manager_sms_numbers: [
        {
          manager_user_id: MGR,
          phone_number: "+12065550123",
          phone_number_sid: "PN123",
          provision_state: "provisioning",
          attachment_state: "attached",
          number_registration_state: "pending",
          registration_submitted_at: new Date(now - 2 * 60 * 60_000).toISOString(),
          last_provider_event_at: new Date(now - 5 * 60_000).toISOString(),
          provider_reconciled_at: null,
          quarantined_at: null,
          quarantine_reason: null,
          updated_at: lifecycleUpdatedAt,
        },
      ],
    });
    listAttachedMock.mockResolvedValue({
      ok: true,
      phoneNumbers: new Set(["+12065550123"]),
    });

    const result = await reconcilePendingManagerNumberOperations(db as never);

    expect(result.needsReview).toBe(0);
    expect(db.__tables.manager_sms_numbers[0]).toMatchObject({
      quarantined_at: null,
      updated_at: lifecycleUpdatedAt,
    });
    expect(db.__tables.manager_sms_numbers[0]?.provider_reconciled_at).toEqual(
      expect.any(String),
    );
  });
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
    expect(rec?.provisionState).toBe("provisioning");
    expect(rec?.phoneNumberSid).toBe("PN123");
    expect(rec?.messagingServiceSid).toBe("MG1");
    const profiles = (db as unknown as { __tables: Record<string, Array<{ sms_from_number: string }>> }).__tables.profiles;
    expect(profiles[0]!.sms_from_number).toBe("+12065550123");

    const second = await provisionManagerNumber(db, MGR);
    expect(second).toMatchObject({ ok: false, error: "setup_in_progress", state: "provisioning" });
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

describe("resolveActiveManagerSendNumber — registration gate", () => {
  it("returns the number only once the manager's registration is approved", async () => {
    process.env.SMS_PROVISIONING_ENABLED = "1";
    purchaseMock.mockResolvedValue({ ok: true, number: "+12065550999", sid: "PN9", messagingServiceSid: "MG1" });
    const db = seed() as never;
    await provisionManagerNumber(db, MGR);
    await markCarrierRegistered(db);
    await setManagerRegistrationState(db, MGR, "pending");

    // Active number but registration still pending → cannot send yet.
    expect(await resolveActiveManagerSendNumber(db, MGR)).toBeNull();

    await setManagerRegistrationState(db, MGR, "approved");
    expect(await resolveActiveManagerSendNumber(db, MGR)).toBe("+12065550999");

    await setManagerRegistrationState(db, MGR, "rejected");
    expect(await resolveActiveManagerSendNumber(db, MGR)).toBeNull();
  });

  it("single shared registration: one env flip makes a shared-ref manager sendable, no per-row write", async () => {
    process.env.SMS_PROVISIONING_ENABLED = "1";
    purchaseMock.mockResolvedValue({ ok: true, number: "+12065550777", sid: "PN7", messagingServiceSid: "MG1" });
    const db = seed() as never;
    // Signup path seeds registration_ref = "shared" and never approves per-row.
    await provisionManagerNumber(db, MGR);
    await markCarrierRegistered(db);
    await setManagerRegistrationState(db, MGR, "pending", { ref: "shared" });
    expect(await resolveActiveManagerSendNumber(db, MGR)).toBeNull();

    process.env.SMS_SHARED_REGISTRATION_STATE = "approved";
    expect(await resolveActiveManagerSendNumber(db, MGR)).toBe("+12065550777");
  });
});
