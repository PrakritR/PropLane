/**
 * MONEY: `GET /api/portal-household-charges` carries a developer convenience — an ACH debit still
 * `processing` after two days reads as `paid`, because no Stripe webhook ever reaches localhost.
 *
 * Captain's decision (2026-10-03): that shortcut runs on a LOCAL dev server ONLY — never on
 * preview/staging/production, and never on any Vercel deployment whatever `VERCEL_ENV` says. On a
 * deployment the webhook is the only authority, so a bounced debit stays bounced. And the write it
 * performs must carry a status precondition, so a row a webhook already moved to `failed` (or
 * `paid`) is never overwritten by a read.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const getUser = vi.fn();
const syncLedgerPaymentEntry = vi.fn(async () => undefined);

const state = {
  charges: [] as Row[],
  updates: [] as { patch: Row; filters: Row; matched: boolean }[],
};

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => false }));
vi.mock("@/lib/auth/manager-lease-scope", () => ({
  managerHasCoManagerPermissionForProperty: async () => false,
}));
vi.mock("@/lib/auth/co-manager-module-scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth/co-manager-module-scope")>();
  return {
    ...actual,
    fetchRowsForManagerWithLinked: async () => [],
    linkedPropertyIdsForModule: async () => new Set<string>(),
    resolveManagerWorkspaceRowScope: async () => ({ propertyIds: null, untaggedOwnedVisible: true }),
  };
});
vi.mock("@/lib/household-charge-payment-eligibility.server", () => ({
  enrichHouseholdChargesFromPropertyRecords: async (_db: unknown, charges: unknown[]) => charges,
}));
vi.mock("@/lib/payment-reminder-lifecycle.server", () => ({
  cancelFuturePaymentRemindersForCharge: async () => undefined,
  restoreFuturePaymentRemindersForCharge: async () => undefined,
}));
vi.mock("@/lib/payment-automation-settings", () => ({
  DEFAULT_MANAGER_AUTOMATION_SETTINGS: {},
  loadManagerAutomationSettings: async () => ({}),
}));
vi.mock("@/lib/payment-reminder-bootstrap", () => ({
  ensureChargeDueDateForReminders: (charge: unknown) => charge,
}));
vi.mock("@/lib/reports/ledger-sync", () => ({
  deleteLedgerEntriesForCharge: async () => undefined,
  householdChargeLedgerFingerprint: () => "fp",
  reconcileDuplicateChargeList: async () => undefined,
  syncLedgerChargeEntry: async () => undefined,
  syncLedgerPaymentEntry: (...args: unknown[]) => syncLedgerPaymentEntry(...(args as [])),
}));
vi.mock("@/lib/domain-action-events.server", () => ({ emitHouseholdChargeTransition: async () => undefined }));
vi.mock("@/lib/payments/property-payout-owner.server", () => ({
  resolvePropertyPayoutOwners: async () => new Map(),
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from(table: string) {
      if (table === "profiles") {
        return {
          select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { email: RESIDENT_EMAIL, role: "resident" } }) }) }),
        };
      }
      if (table === "profile_roles") {
        return { select: () => ({ eq: async () => ({ data: [{ role: "resident" }] }) }) };
      }
      if (table === "portal_recurring_rent_profile_records") {
        const chain = {
          select: () => chain,
          order: () => chain,
          limit: () => chain,
          or: () => chain,
          then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
        };
        return chain;
      }
      if (table === "portal_household_charge_records") {
        const read = {
          select: () => read,
          order: () => read,
          limit: () => read,
          or: () => read,
          then: (resolve: (value: unknown) => unknown) =>
            Promise.resolve({
              data: state.charges.map((row) => ({ id: row.id, row_data: row.row_data, updated_at: row.updated_at })),
              error: null,
            }).then(resolve),
        };
        return {
          ...read,
          update: (patch: Row) => {
            const filters: Row = {};
            const query = {
              eq: (key: string, value: unknown) => {
                filters[key] = value;
                return query;
              },
              select: () => query,
              then: (resolve: (value: unknown) => unknown) => {
                const row = state.charges.find((candidate) => candidate.id === filters.id);
                const matched = Boolean(
                  row &&
                    Object.entries(filters).every(([key, value]) => key === "id" || (row[key] ?? null) === value),
                );
                state.updates.push({ patch, filters, matched });
                if (matched && row) Object.assign(row, patch);
                return Promise.resolve({ data: matched ? [{ id: filters.id }] : [], error: null }).then(resolve);
              },
            };
            return query;
          },
        };
      }
      throw new Error(`unexpected table: ${table}`);
    },
  }),
}));

const RESIDENT_ID = "11111111-1111-4111-8111-111111111111";
const RESIDENT_EMAIL = "resident@test.local";
const CHARGE_ID = "chg-processing";

const { GET } = await import("@/app/api/portal-household-charges/route");

/** An ACH debit submitted three days ago and still clearing. */
function processingRow(statusColumn = "processing"): Row {
  const startedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
  return {
    id: CHARGE_ID,
    status: statusColumn,
    updated_at: startedAt,
    row_data: {
      id: CHARGE_ID,
      kind: "rent",
      status: "processing",
      processingStartedAt: startedAt,
      createdAt: startedAt,
      amountLabel: "$1,200.00",
      balanceLabel: "$1,200.00",
      residentEmail: RESIDENT_EMAIL,
      residentName: "Resident",
      residentUserId: RESIDENT_ID,
      propertyId: "prop-1",
      propertyLabel: "Test Property",
      managerUserId: "22222222-2222-4222-8222-222222222222",
      title: "Rent",
      blocksLeaseUntilPaid: false,
    },
  };
}

async function readCharges(): Promise<{ status: string }[]> {
  const response = await GET();
  expect(response.status).toBe(200);
  return (await response.json()).charges as { status: string }[];
}

beforeEach(() => {
  vi.clearAllMocks();
  state.charges = [processingRow()];
  state.updates = [];
  getUser.mockResolvedValue({ data: { user: { id: RESIDENT_ID, email: RESIDENT_EMAIL } } });
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("VERCEL", "");
  vi.stubEnv("VERCEL_ENV", "");
});

describe("the stale-ACH shortcut runs on a local dev server only", () => {
  it("settles a long-clearing debit on localhost and writes the payment to the ledger", async () => {
    const charges = await readCharges();

    expect(charges[0]!.status).toBe("paid");
    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]!.filters).toMatchObject({ id: CHARGE_ID, status: "processing" });
    expect((state.charges[0]!.row_data as Row).status).toBe("paid");
    expect(syncLedgerPaymentEntry).toHaveBeenCalledTimes(1);
    expect(syncLedgerPaymentEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ id: CHARGE_ID, status: "paid" }),
      expect.any(String),
    );
  });

  it.each([
    ["preview", { VERCEL: "1", VERCEL_ENV: "preview" }],
    ["production", { VERCEL: "1", VERCEL_ENV: "production" }],
    ["a Vercel build with no VERCEL_ENV", { VERCEL: "1", VERCEL_ENV: "" }],
  ])("leaves a clearing debit alone on %s", async (_label, env) => {
    vi.stubEnv("VERCEL", env.VERCEL);
    vi.stubEnv("VERCEL_ENV", env.VERCEL_ENV);

    const charges = await readCharges();

    expect(charges[0]!.status).toBe("processing");
    expect(state.updates).toEqual([]);
    expect(syncLedgerPaymentEntry).not.toHaveBeenCalled();
  });

  it("leaves a clearing debit alone when the build is not a development build", async () => {
    vi.stubEnv("NODE_ENV", "production");

    const charges = await readCharges();

    expect(charges[0]!.status).toBe("processing");
    expect(state.updates).toEqual([]);
  });
});

describe("the shortcut's write can only flip a row that is still processing", () => {
  it("never overwrites a debit a webhook already marked failed", async () => {
    state.charges = [processingRow("failed")];

    await readCharges();

    expect(state.updates).toHaveLength(1);
    expect(state.updates[0]!.matched).toBe(false);
    expect(state.charges[0]!.status).toBe("failed");
    expect((state.charges[0]!.row_data as Row).status).toBe("processing");
    expect(syncLedgerPaymentEntry).not.toHaveBeenCalled();
  });

  it("never overwrites a debit a webhook already settled", async () => {
    state.charges = [processingRow("paid")];

    await readCharges();

    expect(state.updates[0]!.matched).toBe(false);
    expect(state.charges[0]!.status).toBe("paid");
    expect(syncLedgerPaymentEntry).not.toHaveBeenCalled();
  });
});
