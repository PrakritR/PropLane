import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  PortfolioImportDraft,
  PortfolioImportProperty,
  PortfolioImportResident,
  PortfolioImportUnit,
} from "@/lib/portfolio-import/types";
import type { ManagerTask } from "@/lib/manager-tasks";

const { runExistingResidentOnboarding, upsertManagerCharges, loadManagerTasks, saveManagerTasks, track } = vi.hoisted(() => ({
  runExistingResidentOnboarding: vi.fn(),
  upsertManagerCharges: vi.fn(),
  loadManagerTasks: vi.fn(),
  saveManagerTasks: vi.fn(),
  track: vi.fn(),
}));

vi.mock("@/lib/existing-resident-onboarding.server", () => ({ runExistingResidentOnboarding }));
vi.mock("@/lib/household-charges.server", () => ({ upsertManagerCharges }));
vi.mock("@/lib/manager-tasks.server", () => ({ loadManagerTasks, saveManagerTasks }));
vi.mock("@/lib/analytics/posthog", () => ({ track }));

import { commitPortfolioImport, PortfolioImportBlockedError } from "@/lib/portfolio-import/commit.server";

// ---------------------------------------------------------------------------
// Minimal in-memory fake of the postgrest chain the commit path touches:
// manager_portfolio_imports, manager_portfolio_import_records,
// manager_property_records, manager_application_records.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function createFakeDb() {
  const tables: Record<string, Row[]> = {
    manager_portfolio_imports: [],
    manager_portfolio_import_records: [],
    manager_property_records: [],
    manager_application_records: [],
  };

  function from(table: string) {
    const filters: Array<[string, string, unknown]> = [];
    let mode: "select" | "insert" | "upsert" | "update" = "select";
    let payload: Row | Row[] | null = null;
    let upsertOpts: { onConflict?: string; ignoreDuplicates?: boolean } = {};
    let limitN: number | null = null;

    const list = () => (tables[table] ??= []);

    function matches(row: Row): boolean {
      return filters.every(([col, op, val]) => {
        const v = row[col];
        if (op === "eq") return v === val;
        if (op === "neq") return v !== val;
        if (op === "in") return Array.isArray(val) && (val as unknown[]).includes(v);
        return true;
      });
    }

    function conflictCols(): string[] {
      if (upsertOpts.onConflict) return upsertOpts.onConflict.split(",");
      return ["id"];
    }

    async function resolve(single: boolean): Promise<{ data: unknown; error: { message: string; code?: string } | null }> {
      if (mode === "insert" || mode === "upsert") {
        const items = Array.isArray(payload) ? payload : [payload as Row];
        const cols = conflictCols();
        const out: Row[] = [];
        for (const item of items) {
          const idx = list().findIndex((r) => cols.every((c) => r[c] === item[c]));
          if (idx >= 0) {
            if (mode === "upsert" && upsertOpts.ignoreDuplicates) {
              out.push(list()[idx]);
              continue;
            }
            list()[idx] = { ...list()[idx], ...item };
            out.push(list()[idx]);
            continue;
          }
          if (table === "manager_portfolio_imports" && mode === "insert") {
            const dupe = list().find(
              (r) => r.manager_user_id === item.manager_user_id && r.file_sha256 === item.file_sha256 && r.status !== "discarded",
            );
            if (dupe) return { data: null, error: { message: "duplicate key", code: "23505" } };
          }
          const row: Row = {
            id: item.id ?? `row_${Math.random().toString(36).slice(2)}`,
            created_at: new Date().toISOString(),
            ...(table === "manager_portfolio_import_records" ? { status: "prepared", canonical_id: null, error: null } : {}),
            ...item,
          };
          list().push(row);
          out.push(row);
        }
        return single ? { data: out[0] ?? null, error: null } : { data: out, error: null };
      }
      if (mode === "update") {
        const matched = list().filter(matches);
        for (const row of matched) Object.assign(row, payload);
        return single ? { data: matched[0] ?? null, error: null } : { data: matched, error: null };
      }
      let matched = list().filter(matches);
      if (limitN != null) matched = matched.slice(0, limitN);
      return single ? { data: matched[0] ?? null, error: null } : { data: matched, error: null };
    }

    const api = {
      select: () => api,
      insert(p: Row | Row[]) {
        mode = "insert";
        payload = p;
        return api;
      },
      upsert(p: Row | Row[], opts?: { onConflict?: string; ignoreDuplicates?: boolean }) {
        mode = "upsert";
        payload = p;
        upsertOpts = opts ?? {};
        return api;
      },
      update(p: Row) {
        mode = "update";
        payload = p;
        return api;
      },
      eq(col: string, val: unknown) {
        filters.push([col, "eq", val]);
        return api;
      },
      neq(col: string, val: unknown) {
        filters.push([col, "neq", val]);
        return api;
      },
      in(col: string, vals: unknown[]) {
        filters.push([col, "in", vals]);
        return api;
      },
      not() {
        return api;
      },
      limit(n: number) {
        limitN = n;
        return api;
      },
      order() {
        return api;
      },
      maybeSingle: () => resolve(true),
      single: () => resolve(true),
      then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
        return resolve(false).then(onFulfilled, onRejected);
      },
    };
    return api;
  }

  return { from, tables };
}

function property(overrides: Partial<PortfolioImportProperty> = {}): PortfolioImportProperty {
  return {
    key: "p1",
    name: "The Pioneer",
    address: "123 Main St",
    city: "Seattle",
    state: "WA",
    zip: "98101",
    beds: 0,
    baths: 0,
    inventoryKind: "unit",
    unitKeys: ["p1__unit-1", "p1__unit-2"],
    source: { row: 1 },
    ...overrides,
  };
}

function unit(overrides: Partial<PortfolioImportUnit> = {}): PortfolioImportUnit {
  return {
    key: "p1__unit-1",
    propertyKey: "p1",
    label: "Unit 1",
    monthlyRent: 1000,
    securityDeposit: null,
    occupancy: "occupied",
    residentKeys: ["p1__unit-1__alice"],
    source: { row: 1 },
    ...overrides,
  };
}

function resident(overrides: Partial<PortfolioImportResident> = {}): PortfolioImportResident {
  return {
    key: "p1__unit-1__alice",
    propertyKey: "p1",
    unitKey: "p1__unit-1",
    name: "Alice Resident",
    email: "alice@test.proplane.local",
    phone: null,
    leaseStart: "2026-01-01",
    leaseEnd: null,
    moveIn: "2026-01-01",
    monthlyRent: 1000,
    securityDeposit: null,
    balance: null,
    inviteChannels: { email: true, text: false },
    source: { row: 1 },
    ...overrides,
  };
}

function baseDraft(overrides: Partial<PortfolioImportDraft> = {}): PortfolioImportDraft {
  return {
    version: 1,
    sourceKind: "csv",
    preset: "generic",
    fileName: "roster.csv",
    rowCount: 2,
    columns: [],
    properties: [property()],
    units: [unit({ key: "p1__unit-1" }), unit({ key: "p1__unit-2", label: "Unit 2", monthlyRent: 1200, residentKeys: ["p1__unit-2__bob"] })],
    residents: [resident(), resident({ key: "p1__unit-2__bob", unitKey: "p1__unit-2", name: "Bob Resident", email: "bob@test.proplane.local" })],
    balances: [],
    tasks: [
      {
        key: "connect_payouts",
        kind: "connect_payouts",
        title: "Connect payouts to collect rent in PropLane",
        dueDate: "2026-01-08",
        taskType: "general",
        urgency: "scheduled",
      },
    ],
    issues: [],
    aiMappedHeaders: false,
    ...overrides,
  };
}

function seedImport(db: ReturnType<typeof createFakeDb>, draft: PortfolioImportDraft, managerUserId = "mgr-1", importId = "import-1") {
  db.tables.manager_portfolio_imports.push({
    id: importId,
    manager_user_id: managerUserId,
    source_kind: draft.sourceKind,
    preset: draft.preset,
    file_name: draft.fileName,
    file_sha256: "a".repeat(64),
    status: "draft",
    draft: { version: 1, table: { headers: [], rows: [], skippedRows: [] }, draft },
    result: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    committed_at: null,
  });
  return importId;
}

describe("commitPortfolioImport", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    runExistingResidentOnboarding.mockResolvedValue({ ok: true, leaseId: "lease-1", welcomeEmailSent: false, axisId: "x", row: {} });
    loadManagerTasks.mockResolvedValue([]);
    saveManagerTasks.mockResolvedValue([]);
    upsertManagerCharges.mockResolvedValue(undefined);
  });

  it("refuses to commit while blocking issues are unresolved", async () => {
    const db = createFakeDb();
    const draft = baseDraft({
      issues: [{ id: "missing_email:p1", code: "missing_email", severity: "block", message: "No email." }],
    });
    const importId = seedImport(db, draft);

    await expect(
      commitPortfolioImport({ db: db as never, managerUserId: "mgr-1", actor: { userId: "mgr-1", email: "m@test.proplane.local" }, importId }),
    ).rejects.toBeInstanceOf(PortfolioImportBlockedError);
  });

  it("creates properties as unlisted, places residents, and sends no welcome email", async () => {
    const db = createFakeDb();
    const draft = baseDraft();
    const importId = seedImport(db, draft);

    const result = await commitPortfolioImport({
      db: db as never,
      managerUserId: "mgr-1",
      actor: { userId: "mgr-1", email: "m@test.proplane.local", managerName: "Morgan Manager" },
      importId,
    });

    expect(result.status).toBe("completed");
    expect(result.propertyIds).toHaveLength(1);
    expect(result.residentApplicationIds).toHaveLength(2);
    expect(db.tables.manager_property_records[0]?.status).toBe("unlisted");

    // Onboarding never sends the welcome email from a commit.
    expect(runExistingResidentOnboarding).toHaveBeenCalledTimes(2);
    for (const call of runExistingResidentOnboarding.mock.calls) {
      expect((call[3] as { sendWelcomeEmail?: boolean }).sendWelcomeEmail).toBe(false);
    }
  });

  it("skips excluded rows entirely", async () => {
    const db = createFakeDb();
    const draft = baseDraft({
      units: [unit({ key: "p1__unit-1" }), unit({ key: "p1__unit-2", label: "Unit 2", excluded: true, residentKeys: ["p1__unit-2__bob"] })],
      residents: [resident(), resident({ key: "p1__unit-2__bob", unitKey: "p1__unit-2", name: "Bob Resident", email: "bob@test.proplane.local" })],
    });
    const importId = seedImport(db, draft);

    const result = await commitPortfolioImport({
      db: db as never,
      managerUserId: "mgr-1",
      actor: { userId: "mgr-1", email: "m@test.proplane.local" },
      importId,
    });

    expect(result.status).toBe("completed");
    expect(result.residentApplicationIds).toHaveLength(1);
    expect(db.tables.manager_application_records).toHaveLength(1);
  });

  it("leaves a failed receipt for a resident whose email belongs to another manager, and completes the rest as partial", async () => {
    const db = createFakeDb();
    // Bob's email is already owned by a different manager.
    db.tables.manager_application_records.push({
      id: "existing-app",
      manager_user_id: "someone-else",
      resident_email: "bob@test.proplane.local",
      row_data: {},
    });
    const draft = baseDraft();
    const importId = seedImport(db, draft);

    const result = await commitPortfolioImport({
      db: db as never,
      managerUserId: "mgr-1",
      actor: { userId: "mgr-1", email: "m@test.proplane.local" },
      importId,
    });

    expect(result.status).toBe("partial");
    expect(result.residentApplicationIds).toHaveLength(1);
    expect(result.failures.some((f) => f.recordKind === "resident" && f.message.includes("already belongs to another manager"))).toBe(true);

    const bobReceipt = db.tables.manager_portfolio_import_records.find(
      (r) => r.record_kind === "resident" && r.source_key === "p1__unit-2__bob",
    );
    expect(bobReceipt?.status).toBe("prepared");
    expect(bobReceipt?.error).toContain("already belongs to another manager");

    const importRow = db.tables.manager_portfolio_imports.find((r) => r.id === importId);
    expect(importRow?.status).toBe("completed"); // not every record failed
  });

  it("re-running an already-committed import creates nothing new and dedupes tasks", async () => {
    const db = createFakeDb();
    const draft = baseDraft();
    const importId = seedImport(db, draft);

    const first = await commitPortfolioImport({
      db: db as never,
      managerUserId: "mgr-1",
      actor: { userId: "mgr-1", email: "m@test.proplane.local" },
      importId,
    });
    expect(first.status).toBe("completed");
    expect(saveManagerTasks).toHaveBeenCalledTimes(1);
    const savedTasks = saveManagerTasks.mock.calls[0]?.[2] as ManagerTask[];

    const propertyCountAfterFirst = db.tables.manager_property_records.length;
    const applicationCountAfterFirst = db.tables.manager_application_records.length;

    // Simulate the tasks now existing on re-run.
    loadManagerTasks.mockResolvedValue(savedTasks);
    saveManagerTasks.mockClear();
    runExistingResidentOnboarding.mockClear();
    upsertManagerCharges.mockClear();

    const second = await commitPortfolioImport({
      db: db as never,
      managerUserId: "mgr-1",
      actor: { userId: "mgr-1", email: "m@test.proplane.local" },
      importId,
    });

    expect(second.status).toBe("completed");
    expect(second.propertyIds).toEqual(first.propertyIds);
    expect(second.residentApplicationIds).toEqual(first.residentApplicationIds);
    expect(db.tables.manager_property_records.length).toBe(propertyCountAfterFirst);
    expect(db.tables.manager_application_records.length).toBe(applicationCountAfterFirst);
    // No resident onboarding call is repeated — the receipt was already completed.
    expect(runExistingResidentOnboarding).not.toHaveBeenCalled();
    // Tasks were already on the board (by dedupKey) — nothing new to save.
    expect(saveManagerTasks).not.toHaveBeenCalled();
  });

  it("creates a balance charge shaped as an unpaid other_cost charge", async () => {
    const db = createFakeDb();
    const draft = baseDraft({
      residents: [resident({ balance: 250 }), resident({ key: "p1__unit-2__bob", unitKey: "p1__unit-2", name: "Bob Resident", email: "bob@test.proplane.local" })],
      balances: [{ key: "balance:p1__unit-1__alice", residentKey: "p1__unit-1__alice", amount: 250, create: true }],
    });
    const importId = seedImport(db, draft);

    const result = await commitPortfolioImport({
      db: db as never,
      managerUserId: "mgr-1",
      actor: { userId: "mgr-1", email: "m@test.proplane.local" },
      importId,
    });

    expect(result.balanceChargeIds).toHaveLength(1);
    expect(upsertManagerCharges).toHaveBeenCalledTimes(1);
    const [, calledManagerId, charges] = upsertManagerCharges.mock.calls[0] as [unknown, string, Array<Record<string, unknown>>];
    expect(calledManagerId).toBe("mgr-1");
    const charge = charges[0]!;
    expect(charge.kind).toBe("other_cost");
    expect(charge.status).toBe("pending");
    expect(charge.amountLabel).toBe("$250.00");
    expect(charge.balanceLabel).toBe("$250.00");
    expect(charge.blocksLeaseUntilPaid).toBe(false);
    expect(charge.migrationSourceId).toBe(`${importId}:p1__unit-1__alice`);
  });

  it("skips a balance whose create flag was unticked", async () => {
    const db = createFakeDb();
    const draft = baseDraft({
      residents: [resident({ balance: 250 }), resident({ key: "p1__unit-2__bob", unitKey: "p1__unit-2", name: "Bob Resident", email: "bob@test.proplane.local" })],
      balances: [{ key: "balance:p1__unit-1__alice", residentKey: "p1__unit-1__alice", amount: 250, create: false }],
    });
    const importId = seedImport(db, draft);

    const result = await commitPortfolioImport({
      db: db as never,
      managerUserId: "mgr-1",
      actor: { userId: "mgr-1", email: "m@test.proplane.local" },
      importId,
    });

    expect(result.balanceChargeIds).toHaveLength(0);
    expect(upsertManagerCharges).not.toHaveBeenCalled();
  });
});
