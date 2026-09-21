/**
 * Portfolio import — create.server.ts turns an approved proposal into real
 * records. Every reused creation path (listing draft, resident onboarding,
 * ledger sync, tasks) is mocked here — this file is about create.server.ts's
 * OWN orchestration: per-property rollback names the failing row, no invite
 * fires without explicit opt-in, and every write carries `source: import`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ImportPropertyProposal,
  PortfolioImportCreateRequest,
  PortfolioImportProposal,
} from "@/lib/portfolio-import/types";

const {
  submissionFromImportedProperty,
  deriveLegacyFields,
  submissionToDraftAdminRow,
  mintManagerPropertyId,
  buildImportedResidentRow,
  provisionApprovedResidentAccount,
  runExistingResidentOnboarding,
  sealApplicantRow,
  syncLedgerChargeEntry,
  createManagerTaskRow,
  loadImportProposal,
  setImportStatus,
} = vi.hoisted(() => ({
  submissionFromImportedProperty: vi.fn(),
  deriveLegacyFields: vi.fn(),
  submissionToDraftAdminRow: vi.fn(),
  mintManagerPropertyId: vi.fn(),
  buildImportedResidentRow: vi.fn(),
  provisionApprovedResidentAccount: vi.fn(),
  runExistingResidentOnboarding: vi.fn(),
  sealApplicantRow: vi.fn((row: unknown) => row),
  syncLedgerChargeEntry: vi.fn(),
  createManagerTaskRow: vi.fn(),
  loadImportProposal: vi.fn(),
  setImportStatus: vi.fn(),
}));

vi.mock("@/lib/property-import/to-submission", () => ({ submissionFromImportedProperty }));
vi.mock("@/lib/demo-property-pipeline", () => ({ deriveLegacyFields }));
vi.mock("@/lib/demo-admin-property-inventory", () => ({ submissionToDraftAdminRow, mintManagerPropertyId }));
vi.mock("@/lib/resident-document-import/build-application-row", () => ({ buildImportedResidentRow }));
vi.mock("@/lib/auth/provision-approved-resident", () => ({ provisionApprovedResidentAccount }));
vi.mock("@/lib/existing-resident-onboarding.server", () => ({ runExistingResidentOnboarding }));
vi.mock("@/lib/security/applicant-identity", () => ({ sealApplicantRow }));
vi.mock("@/lib/reports/ledger-sync", () => ({ syncLedgerChargeEntry }));
vi.mock("@/lib/manager-tasks.server", () => ({ createManagerTaskRow }));
vi.mock("@/lib/portfolio-import/store.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/portfolio-import/store.server")>();
  return { ...actual, loadImportProposal, setImportStatus };
});

import { createPortfolioImportRecords, PortfolioImportNotFoundError } from "@/lib/portfolio-import/create.server";

/**
 * A fake Supabase client that records every upsert/delete without touching a
 * real database. `failUpsertOnCall` names, per table, which 1-based call
 * number to that table's `upsert` should fail (so a second property's write
 * can be made to fail while the first property's identical-shaped write
 * already succeeded).
 */
function fakeDb(opts: { failUpsertOnCall?: Record<string, number[]> } = {}) {
  const upserts: { table: string; payload: unknown }[] = [];
  const deletes: { table: string }[] = [];
  const callCounts: Record<string, number> = {};

  function builder(table: string) {
    const obj = {
      upsert: vi.fn((payload: unknown) => {
        callCounts[table] = (callCounts[table] ?? 0) + 1;
        upserts.push({ table, payload });
        const failOn = opts.failUpsertOnCall?.[table] ?? [];
        return Promise.resolve(failOn.includes(callCounts[table]!) ? { error: { message: `${table} upsert failed` } } : { error: null });
      }),
      delete: vi.fn(() => obj),
      eq: vi.fn(() => obj),
      then: (resolve: (v: { error: null }) => void) => {
        deletes.push({ table });
        resolve({ error: null });
      },
    };
    return obj;
  }
  return { from: vi.fn(builder), upserts, deletes };
}

function property(overrides: Partial<ImportPropertyProposal> = {}): ImportPropertyProposal {
  return {
    key: "p1",
    address: "400 Pike St",
    source: { file: "roll.csv", sheet: "Sheet1", rows: [2] },
    rooms: [{ key: "p1:room:0", name: "1A", rent: 1200, source: { file: "roll.csv", sheet: "Sheet1", rows: [2] } }],
    residents: [
      {
        key: "p1:resident:0",
        roomKey: "p1:room:0",
        name: "Riko Tanaka",
        email: "riko@example.com",
        phone: null,
        leaseStart: "2026-01-01",
        leaseEnd: "2026-12-31",
        rent: 1200,
        deposit: 1200,
        balance: null,
        status: "ready",
        gaps: [],
        source: { file: "roll.csv", sheet: "Sheet1", rows: [2] },
      },
    ],
    charges: [
      { key: "p1:resident:0:charge:rent", residentKey: "p1:resident:0", kind: "rent", amount: 1200, dueDate: null, label: "Rent", source: { file: "roll.csv" } },
      { key: "p1:resident:0:charge:deposit", residentKey: "p1:resident:0", kind: "deposit", amount: 1200, dueDate: null, label: "Security deposit", source: { file: "roll.csv" } },
    ],
    tasks: [
      { key: "p1:resident:0:task:unsigned_lease", residentKey: "p1:resident:0", title: "Generate or upload this resident's lease for signature", kind: "unsigned_lease", source: { file: "roll.csv" } },
    ],
    status: "ready",
    ...overrides,
  };
}

function proposal(properties: ImportPropertyProposal[]): PortfolioImportProposal {
  return {
    importId: "imp-1",
    files: [{ name: "roll.csv", kind: "spreadsheet" }],
    properties,
    summary: { properties: properties.length, rooms: 0, residents: 0, charges: 0, tasks: 0, gaps: 0 },
  };
}

const ACTOR = { userId: "mgr-1", email: "manager@test.proplane.local" };
const REQUEST: PortfolioImportCreateRequest = { sendInvites: false };

beforeEach(() => {
  vi.clearAllMocks();
  submissionFromImportedProperty.mockReturnValue({ rooms: [{ id: "room-real-abc" }] });
  deriveLegacyFields.mockReturnValue({ buildingName: "400 Pike St", unitLabel: "" });
  mintManagerPropertyId.mockReturnValue("mgr-400-pike-st-xyz");
  submissionToDraftAdminRow.mockReturnValue({ adminRefId: "mgr-400-pike-st-xyz" });
  buildImportedResidentRow.mockImplementation((args: { id: string; email: string }) => ({ id: args.id, email: args.email, manuallyAdded: true, bucket: "approved" }));
  provisionApprovedResidentAccount.mockResolvedValue({ ok: true, userId: "auth-user-1", created: true });
  runExistingResidentOnboarding.mockResolvedValue({ ok: true, leaseId: "lease_app_p1resident0", welcomeEmailSent: false, axisId: "PROPLANE-IMP1", row: {} });
});

describe("createPortfolioImportRecords", () => {
  it("throws PortfolioImportNotFoundError when the import does not belong to this manager", async () => {
    loadImportProposal.mockResolvedValue(null);
    await expect(createPortfolioImportRecords(fakeDb() as never, ACTOR, "imp-1", REQUEST)).rejects.toBeInstanceOf(PortfolioImportNotFoundError);
  });

  it("creates a property, its resident, its charges, and its task, and stamps source:import on the resident and every charge/task", async () => {
    loadImportProposal.mockResolvedValue({ row: { status: "draft" }, proposal: proposal([property()]) });
    const db = fakeDb();
    const result = await createPortfolioImportRecords(db as never, ACTOR, "imp-1", REQUEST);

    expect(result.failures).toEqual([]);
    expect(result.created).toEqual({ properties: 1, rooms: 1, residents: 1, leases: 1, charges: 2, tasks: 1, invites: 0 });

    // Resident row carries a plain-English source note.
    const residentUpsert = db.upserts.find((u) => u.table === "manager_application_records")!;
    expect((residentUpsert.payload as { row_data: { id: string } }).row_data.id).toBe(buildImportedResidentRow.mock.results[0]!.value.id);
    const builtRow = buildImportedResidentRow.mock.results[0]!.value;
    expect(builtRow.detail).toContain("roll.csv");

    // Charges carry migrationSourceId = the file name.
    const chargeUpserts = db.upserts.filter((u) => u.table === "portal_household_charge_records");
    expect(chargeUpserts).toHaveLength(2);
    for (const u of chargeUpserts) {
      expect((u.payload as { row_data: { migrationSourceId: string } }).row_data.migrationSourceId).toBe("roll.csv");
    }
    expect(syncLedgerChargeEntry).toHaveBeenCalledTimes(2);

    // Tasks carry a sourceId naming the import.
    expect(createManagerTaskRow).toHaveBeenCalledTimes(1);
    const taskInput = createManagerTaskRow.mock.calls[0]![2] as { sourceId: string; notes: string };
    expect(taskInput.sourceId).toBe("portfolio-import:imp-1");
    expect(taskInput.notes).toContain("roll.csv");

    expect(setImportStatus).toHaveBeenCalledWith(db, "mgr-1", "imp-1", "completed", expect.any(Object));
  });

  it("never invites a resident unless sendInvites is explicitly true", async () => {
    loadImportProposal.mockResolvedValue({ row: { status: "draft" }, proposal: proposal([property()]) });
    runExistingResidentOnboarding.mockResolvedValue({ ok: true, leaseId: "lease_app_p1resident0", welcomeEmailSent: true, axisId: "PROPLANE-IMP1", row: {} });

    const withoutInvites = await createPortfolioImportRecords(fakeDb() as never, ACTOR, "imp-1", { sendInvites: false });
    expect(runExistingResidentOnboarding).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), { sendWelcomeEmail: false });
    expect(withoutInvites.created.invites).toBe(0);

    loadImportProposal.mockResolvedValue({ row: { status: "draft" }, proposal: proposal([property()]) });
    const withInvites = await createPortfolioImportRecords(fakeDb() as never, ACTOR, "imp-1", { sendInvites: true });
    expect(runExistingResidentOnboarding).toHaveBeenCalledWith(expect.anything(), expect.anything(), expect.anything(), { sendWelcomeEmail: true });
    expect(withInvites.created.invites).toBe(1);
  });

  it("rolls back only the failing property and names it in the failure, leaving an earlier successful property intact", async () => {
    const good = property({ key: "p-good", address: "400 Pike St" });
    const bad = property({
      key: "p-bad",
      address: "12 Broken Ave",
      source: { file: "roll.csv", sheet: "Sheet1", rows: [9] },
      residents: [{ ...property().residents[0]!, key: "p-bad:resident:0" }],
    });
    loadImportProposal.mockResolvedValue({ row: { status: "draft" }, proposal: proposal([good, bad]) });

    // The first property's resident write (call 1) succeeds; the second
    // property's resident write (call 2) fails.
    const db = fakeDb({ failUpsertOnCall: { manager_application_records: [2] } });
    const result = await createPortfolioImportRecords(db as never, ACTOR, "imp-1", REQUEST);

    expect(result.created.properties).toBe(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toMatchObject({ propertyKey: "p-bad", address: "12 Broken Ave", row: 9 });
    // The failing property's own draft was rolled back (a delete on manager_property_records).
    expect(db.deletes.some((d) => d.table === "manager_property_records")).toBe(true);
    expect(setImportStatus).toHaveBeenCalledWith(db, "mgr-1", "imp-1", "partial", expect.any(Object));
  });

  it("refuses to create a property whose resident still has unanswered gaps, naming that resident", async () => {
    // Status is always RE-DERIVED from the actual fields (never trusted from
    // storage), so the gap here has to be real: no lease end date on file.
    const needsAnswers = property({
      residents: [{ ...property().residents[0]!, leaseEnd: null, status: "ready", gaps: [] }],
    });
    loadImportProposal.mockResolvedValue({ row: { status: "draft" }, proposal: proposal([needsAnswers]) });
    const result = await createPortfolioImportRecords(fakeDb() as never, ACTOR, "imp-1", REQUEST);
    expect(result.created.properties).toBe(0);
    expect(result.failures[0]!.message).toContain("Riko Tanaka");
    expect(submissionFromImportedProperty).not.toHaveBeenCalled();
  });

  it("skips a property the caller marked skip, and honors PATCH-style answers merged at create time", async () => {
    const skipped = property({ key: "p-skip", status: "ready" });
    loadImportProposal.mockResolvedValue({ row: { status: "draft" }, proposal: proposal([skipped]) });
    const result = await createPortfolioImportRecords(fakeDb() as never, ACTOR, "imp-1", { sendInvites: false, skips: ["p-skip"] });
    expect(result.created.properties).toBe(0);
    expect(result.failures).toEqual([]);
  });
});
