import { randomBytes } from "node:crypto";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CosignerSubmission } from "@/lib/cosigner-submissions-storage";
import { loadOwnedCosignerRecord, persistOwnedCosignerRecord } from "@/lib/security/cosigner-repository";
import { sealCosignerIdentity, openCosignerIdentity } from "@/lib/security/cosigner-identity";

beforeEach(() => {
  vi.stubEnv("DATA_ENCRYPTION_ACTIVE_KEY_ID", "test");
  vi.stubEnv("DATA_ENCRYPTION_KEYS_JSON", JSON.stringify({ test: randomBytes(32).toString("base64") }));
  vi.stubEnv("COSIGNER_IDENTITY_REQUIRE_ENCRYPTED_READS", "");
});
afterEach(() => vi.unstubAllEnvs());

function database() {
  let owner: string | null = "current-owner";
  let rowData = sealCosignerIdentity({ signerAppId: "app-a", ssn: "***-**-6789", dob: "1980-01-01", dlNumber: "ID-1" } as CosignerSubmission, "cosigner-a", "origin-owner");
  const update = vi.fn((patch: { row_data: Record<string, unknown> }) => {
    rowData = patch.row_data;
    return { eq: () => ({ eq: async () => ({ error: null }) }) };
  });
  const db = { from: (table: string) => ({
    update,
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ error: null, data: table === "cosigner_submission_records"
      ? { id: "cosigner-a", signer_app_id: "app-a", manager_user_id: "stale-origin-owner", row_data: rowData }
      : { manager_user_id: owner, row_data: { id: "app-a", managerUserId: "stale-origin-owner" } } }) }) }),
  }) } as unknown as SupabaseClient;
  return { db, update, transfer: (next: string | null) => { owner = next; }, stored: () => rowData };
}

it("authorizes current parent ownership before decryption, ignoring stale owner stamps", async () => {
  const store = database();
  const record = await loadOwnedCosignerRecord(store.db, "cosigner-a", "current-owner");
  expect(record?.submission.dob).toBe("1980-01-01");
  expect(record?.encryptionOwnerId).toBe("origin-owner");
  expect(record?.signerRow.managerUserId).toBe("current-owner");
  vi.stubEnv("DATA_ENCRYPTION_KEYS_JSON", "");
  // A rejected requester must not reach decryption, even with keys unavailable.
  expect(await loadOwnedCosignerRecord(store.db, "cosigner-a", "stale-origin-owner")).toBeNull();
});

it("ownership transfer preserves decryptability and revokes the previous owner", async () => {
  const store = database();
  store.transfer("next-owner");
  expect(await loadOwnedCosignerRecord(store.db, "cosigner-a", "current-owner")).toBeNull();
  expect((await loadOwnedCosignerRecord(store.db, "cosigner-a", "next-owner"))?.submission.dob).toBe("1980-01-01");
});

it("screening saves encrypt identity and preserve original binding; transfer before save denies", async () => {
  const store = database();
  const record = (await loadOwnedCosignerRecord(store.db, "cosigner-a", "current-owner"))!;
  await persistOwnedCosignerRecord(store.db, { ...record, submission: { ...record.submission, fullName: "Updated synthetic" } });
  expect(store.stored().dob).toMatch(/^proplane:/);
  expect(openCosignerIdentity(store.stored(), "cosigner-a").fullName).toBe("Updated synthetic");
  store.transfer("next-owner");
  await expect(persistOwnedCosignerRecord(store.db, record)).rejects.toThrow(/access/);
  expect(store.update).toHaveBeenCalledOnce();
});

it("fails closed when parent ownership is removed despite stale parent and child stamps", async () => {
  const store = database();
  const record = (await loadOwnedCosignerRecord(store.db, "cosigner-a", "current-owner"))!;
  store.transfer(null);
  vi.stubEnv("DATA_ENCRYPTION_KEYS_JSON", "");
  expect(await loadOwnedCosignerRecord(store.db, "cosigner-a", "stale-origin-owner")).toBeNull();
  expect(await loadOwnedCosignerRecord(store.db, "cosigner-a", "current-owner")).toBeNull();
  await expect(persistOwnedCosignerRecord(store.db, record)).rejects.toThrow(/access/);
  expect(store.update).not.toHaveBeenCalled();
});
