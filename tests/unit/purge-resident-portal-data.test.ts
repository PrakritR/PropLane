import { describe, expect, it, vi } from "vitest";
import {
  purgeApplicationPortalData,
  purgeManagerPortalData,
  purgeResidentPortalData,
} from "@/lib/auth/purge-portal-account-data";

vi.mock("@/lib/auth/purge-orphaned-co-manager-links", () => ({
  purgeCoManagerReferencesToUser: vi.fn(async () => undefined),
}));

function mockDeleteChain() {
  return {
    select: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    neq: vi.fn().mockReturnThis(),
    in: vi.fn().mockReturnThis(),
    filter: vi.fn().mockReturnThis(),
    ilike: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn(async () => ({ data: null, error: null })),
    // Resolves both delete ops ({ error }) and the manager_application_records
    // id lookup ({ data }) so the email-based screening/cosigner purge runs.
    then: (resolve: (value: { error: null; data: { id: string }[] }) => void) =>
      resolve({ error: null, data: [{ id: "app-1" }] }),
  };
}

/** Storage stub: every bucket lists one photo object and records what was removed. */
function mockStorage() {
  const removed: { bucket: string; paths: string[] }[] = [];
  const storage = {
    from: vi.fn((bucket: string) => ({
      list: vi.fn(async () => ({ data: [{ name: "idPhotoFront-1-abc.jpg" }], error: null })),
      remove: vi.fn(async (paths: string[]) => {
        removed.push({ bucket, paths });
        return { data: null, error: null };
      }),
    })),
  };
  return { storage, removed };
}

describe("purgeResidentPortalData", () => {
  it("purges service requests, ledger, screening, cosigner, and scheduled inbox rows", async () => {
    const chain = mockDeleteChain();
    const db = { from: vi.fn(() => chain) } as unknown as Parameters<typeof purgeResidentPortalData>[0];

    await purgeResidentPortalData(db, {
      email: "resident@example.com",
      userId: "user-1",
      applicationId: "app-1",
    });

    const tables = db.from.mock.calls.map((call) => call[0]);
    expect(tables).toContain("portal_service_request_records");
    expect(tables).toContain("ledger_entries");
    expect(tables).toContain("cosigner_submission_records");
    expect(tables).toContain("screening_orders");
    expect(tables).toContain("portal_scheduled_inbox_message_records");
    expect(db.from).toHaveBeenCalled();
  });

  it("reclaims the application-documents photo bytes for every deleted application row (retention Option A)", async () => {
    // Full resident purge (delete resident from Residents tab) still reclaims
    // photos for every application row tied to that email.
    const chain = mockDeleteChain();
    const { storage, removed } = mockStorage();
    const db = { from: vi.fn(() => chain), storage } as unknown as Parameters<typeof purgeResidentPortalData>[0];

    await purgeResidentPortalData(db, { email: "resident@example.com", applicationId: "PROPLANE-DCA4B226" });

    expect(storage.from).toHaveBeenCalledWith("application-documents");
    const folders = removed.flatMap((r) => r.paths);
    // The email lookup resolved application "app-1"; the explicit id was also passed.
    expect(folders).toContain("application/PROPLANE-APP1/idPhotoFront-1-abc.jpg");
    expect(folders).toContain("application/PROPLANE-DCA4B226/idPhotoFront-1-abc.jpg");
  });
});

describe("purgeApplicationPortalData", () => {
  it("purges only application-scoped rows and reclaims photos", async () => {
    const chain = mockDeleteChain();
    const { storage, removed } = mockStorage();
    const db = { from: vi.fn(() => chain), storage } as unknown as Parameters<typeof purgeApplicationPortalData>[0];

    await purgeApplicationPortalData(db, "PROPLANE-APP1");

    const tables = db.from.mock.calls.map((call) => call[0]);
    expect(tables).toContain("manager_application_records");
    expect(tables).toContain("portal_household_charge_records");
    expect(tables).toContain("screening_orders");
    expect(tables).not.toContain("profiles");
    expect(storage.from).toHaveBeenCalledWith("application-documents");
    expect(removed.flatMap((r) => r.paths)).toContain("application/PROPLANE-APP1/idPhotoFront-1-abc.jpg");
  });
});

describe("purgeManagerPortalData", () => {
  it("reclaims photo bytes for the manager's deleted application rows too", async () => {
    const chain = mockDeleteChain();
    const { storage, removed } = mockStorage();
    const db = { from: vi.fn(() => chain), storage } as unknown as Parameters<typeof purgeManagerPortalData>[0];

    await purgeManagerPortalData(db, "mgr-user-1");

    const buckets = removed.map((r) => r.bucket);
    expect(buckets).toContain("application-documents");
    expect(removed.flatMap((r) => r.paths)).toContain("application/PROPLANE-APP1/idPhotoFront-1-abc.jpg");
  });

  it("purges ledger, GL, vendor AP, service requests, and agent rows", async () => {
    const chain = mockDeleteChain();
    const db = { from: vi.fn(() => chain), storage: mockStorage().storage } as unknown as Parameters<
      typeof purgeManagerPortalData
    >[0];

    await purgeManagerPortalData(db, "mgr-user-1");

    const tables = db.from.mock.calls.map((call) => call[0]);
    expect(tables).toContain("ledger_entries");
    expect(tables).toContain("gl_journal_entries");
    expect(tables).toContain("portal_service_request_records");
    expect(tables).toContain("vendor_invoices");
    expect(tables).toContain("agent_pending_actions");
    expect(tables).toContain("manager_sms_numbers");
  });
});
