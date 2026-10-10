/**
 * `POST /api/manager-applications` as a manager: a row may only NAME houses the writer runs.
 *
 * Readers count an approved row toward every property it names (property columns and the
 * `propertyId::roomId` room-choice values), so a row filed under the writer's own house whose
 * `assignedPropertyId` / `assignedRoomChoice` / `roomChoice1` points at a victim's house used to
 * publish the victim's room as occupied.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";

const getUser = vi.fn();
let PROPERTIES: { id: string; manager_user_id: string }[];
let UPSERTS: { id: string; manager_user_id: string | null }[];
let EDIT_GRANTS: Record<string, string[]>;
let ROLE = "manager";

vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: vi.fn(async () => false) }));
vi.mock("@/lib/auth/co-manager-module-scope", () => ({
  linkedPropertyIdsForModule: vi.fn(async () => new Set<string>()),
  linkedOwnerForProperty: vi.fn(async () => null),
}));
vi.mock("@/lib/auth/manager-lease-scope", () => ({
  managerHasCoManagerPermissionForProperty: vi.fn(
    async (_db: unknown, userId: string, propertyId: string) => (EDIT_GRANTS[userId] ?? []).includes(propertyId),
  ),
}));
vi.mock("@/lib/auth/provision-approved-resident", () => ({ provisionApprovedResidentAccount: vi.fn(async () => ({ ok: true })) }));
vi.mock("@/lib/screening/order-screening", () => ({ tryAutoOrderScreening: vi.fn() }));
vi.mock("@/lib/workspaces/scope.server", () => ({ activeWorkspacePropertyScope: vi.fn(async () => null) }));
vi.mock("@/lib/supabase/server", () => ({ createSupabaseServerClient: async () => ({ auth: { getUser } }) }));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => makeDb() }));

function makeDb() {
  return {
    storage: { from: () => ({ list: async () => ({ data: [], error: null }), remove: async () => ({ error: null }) }) },
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        upsert(values: { id: string; manager_user_id: string | null }) {
          if (table === "manager_application_records") UPSERTS.push(values);
          return Promise.resolve({ error: null });
        },
        eq: () => builder,
        in: () => builder,
        is: () => builder,
        neq: () => builder,
        ilike: () => builder,
        or: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: () =>
          Promise.resolve({ data: table === "profiles" ? { role: ROLE, email: "mgr@test.local" } : null, error: null }),
        then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
          return Promise.resolve({ data: table === "manager_property_records" ? PROPERTIES : [], error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
}

const ATTACKER = "mgr-attacker";
const OWN_HOUSE = "house-own";
const VICTIM_HOUSE = "house-victim";

function approved(extra: Record<string, unknown> = {}): DemoApplicantRow {
  return {
    id: "AXIS-PLANT1",
    name: "Planted Resident",
    email: "planted@example.com",
    property: OWN_HOUSE,
    propertyId: OWN_HOUSE,
    stage: "Active",
    bucket: "approved",
    detail: "",
    manuallyAdded: true,
    manualResidentDetails: { moveInDate: "2026-10-01", moveOutDate: "2027-09-30" },
    ...extra,
  } as unknown as DemoApplicantRow;
}

async function upsert(row: DemoApplicantRow) {
  const { POST } = await import("@/app/api/manager-applications/route");
  const res = await POST(
    new Request("http://localhost/api/manager-applications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "upsert", row }),
    }),
  );
  return res.status;
}

beforeEach(() => {
  vi.resetModules();
  UPSERTS = [];
  EDIT_GRANTS = {};
  ROLE = "manager";
  PROPERTIES = [
    { id: OWN_HOUSE, manager_user_id: ATTACKER },
    { id: VICTIM_HOUSE, manager_user_id: "mgr-victim" },
  ];
  getUser.mockResolvedValue({ data: { user: { id: ATTACKER, email: "mgr@test.local", user_metadata: { role: "manager" } } }, error: null });
});

describe("manager application writes may only name houses the writer runs", () => {
  it("refuses a row whose assignedPropertyId is a stranger's house", async () => {
    expect(await upsert(approved({ assignedPropertyId: VICTIM_HOUSE }))).toBe(403);
    expect(UPSERTS).toHaveLength(0);
  });

  it("refuses a stranger's room in assignedRoomChoice", async () => {
    expect(await upsert(approved({ assignedRoomChoice: `${VICTIM_HOUSE}::room-1` }))).toBe(403);
    expect(UPSERTS).toHaveLength(0);
  });

  it("refuses a stranger's room in application.roomChoice1", async () => {
    expect(await upsert(approved({ application: { roomChoice1: `${VICTIM_HOUSE}::room-1`, leaseStart: "2026-10-01" } }))).toBe(403);
    expect(UPSERTS).toHaveLength(0);
  });

  it("refuses a stranger's house in application.propertyId", async () => {
    expect(await upsert(approved({ application: { propertyId: VICTIM_HOUSE } }))).toBe(403);
    expect(UPSERTS).toHaveLength(0);
  });

  it("accepts a row that names only the writer's own house and room", async () => {
    expect(
      await upsert(approved({ assignedPropertyId: OWN_HOUSE, assignedRoomChoice: `${OWN_HOUSE}::room-1`, application: { roomChoice1: `${OWN_HOUSE}::room-1` } })),
    ).toBe(200);
    expect(UPSERTS).toHaveLength(1);
  });

  it("accepts a stranger's house the writer holds an edit grant on", async () => {
    EDIT_GRANTS[ATTACKER] = [VICTIM_HOUSE];
    expect(await upsert(approved({ assignedPropertyId: VICTIM_HOUSE, assignedRoomChoice: `${VICTIM_HOUSE}::room-1` }))).toBe(200);
  });
});

describe("an applicant's own write cannot become a resident slot", () => {
  it("refuses bucket approved and manual-resident fields from a resident account", async () => {
    ROLE = "resident";
    const row = approved({ email: "mgr@test.local", assignedRoomChoice: `${VICTIM_HOUSE}::room-1`, assignedPropertyId: VICTIM_HOUSE });
    expect(await upsert(row)).toBe(403);
    expect(UPSERTS).toHaveLength(0);
  });
});
