/**
 * Evidence harness for the ship-to-production security pass (2026-10-10) — the
 * applications half.
 *
 * Drives the real `/api/manager-applications` handlers and the real guest
 * upsert against a fake database and records the actual HTTP statuses, bodies
 * and stored rows:
 *
 *   1. A manager write may only NAME houses the writer runs — in
 *      `assignedPropertyId`, `assignedRoomChoice` and `application.roomChoice1`
 *      — and the same check runs again when a row is moved to approved.
 *   2. An applicant never sets their own placement, and an applicant account
 *      cannot file itself as a resident slot.
 *   3. The manager list (GET) drops a resident slot a stranger filed naming the
 *      viewer's house.
 *
 * With EVIDENCE_DIR set it writes `security-applications.txt`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import type { DemoApplicantRow } from "@/data/demo-portal";

const OUT = process.env.EVIDENCE_DIR ?? "";
const log: string[] = [];
const say = (line = "") => log.push(line);

const getUser = vi.fn();
let PROPERTIES: { id: string; manager_user_id: string }[];
let UPSERTS: { id: string; manager_user_id: string | null }[];
let EDIT_GRANTS: Record<string, string[]>;
let ROLE = "manager";
let STORED: Record<string, unknown>[] = [];
let LINKS: unknown[] = [];

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
vi.mock("@/lib/rental-application/duplicate-application.server", () => ({ findDuplicateApplication: async () => null }));
vi.mock("@/lib/rental-application/validate-submission.server", () => ({ validateSubmittedApplication: async () => ({ ok: true, errors: {} }) }));

function makeDb() {
  return {
    storage: { from: () => ({ list: async () => ({ data: [], error: null }), remove: async () => ({ error: null }) }) },
    from(table: string) {
      const f: { eqCol: string | null; eqVal: string | null } = { eqCol: null, eqVal: null };
      const builder: Record<string, unknown> = {
        select: () => builder,
        upsert(values: { id: string; manager_user_id: string | null }) {
          if (table === "manager_application_records") UPSERTS.push(values);
          return Promise.resolve({ error: null });
        },
        eq(column: string, value: string) {
          f.eqCol = column;
          f.eqVal = value;
          return builder;
        },
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
          const data =
            table === "manager_property_records"
              ? f.eqCol === "manager_user_id"
                ? PROPERTIES.filter((p) => p.manager_user_id === f.eqVal)
                : PROPERTIES
              : table === "manager_application_records"
                ? f.eqCol === "manager_user_id"
                  ? STORED.filter((r) => r.manager_user_id === f.eqVal)
                  : STORED
                : table === "account_link_invites"
                  ? LINKS
                  : [];
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
}

const ATTACKER = "mgr-attacker";
const OWNER = "mgr-owner";
const TEAMMATE = "mgr-teammate";
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
  const text = await res.text();
  return { status: res.status, body: text.slice(0, 160) };
}

async function record(what: string, row: DemoApplicantRow) {
  const before = UPSERTS.length;
  const { status, body } = await upsert(row);
  const stored = UPSERTS.length > before;
  say(`     ${what.padEnd(56)} -> HTTP ${status}  ${status === 200 ? "stored" : body}`);
  return { status, stored };
}

beforeEach(() => {
  vi.resetModules();
  UPSERTS = [];
  EDIT_GRANTS = {};
  ROLE = "manager";
  STORED = [];
  LINKS = [];
  PROPERTIES = [
    { id: OWN_HOUSE, manager_user_id: ATTACKER },
    { id: VICTIM_HOUSE, manager_user_id: "mgr-victim" },
  ];
  getUser.mockResolvedValue({ data: { user: { id: ATTACKER, email: "mgr@test.local", user_metadata: { role: "manager" } } }, error: null });
});

describe("evidence · a manager write may only name houses the writer runs", () => {
  it("records every refusal and every accepted write", async () => {
    say("PropLane · security evidence · manager applications (2026-10-10)");
    say("Real POST/GET /api/manager-applications handlers against a fake database. Statuses are the route's own.");
    say();
    say("1. The write names a house");
    say(`   Signed in as ${ATTACKER}, who runs ${OWN_HOUSE}. ${VICTIM_HOUSE} belongs to mgr-victim.`);

    const refusals = [
      await record(`assignedPropertyId: "${VICTIM_HOUSE}"`, approved({ assignedPropertyId: VICTIM_HOUSE })),
      await record(`assignedRoomChoice: "${VICTIM_HOUSE}::room-1"`, approved({ assignedRoomChoice: `${VICTIM_HOUSE}::room-1` })),
      await record(
        `application.roomChoice1: "${VICTIM_HOUSE}::room-1"`,
        approved({ application: { roomChoice1: `${VICTIM_HOUSE}::room-1`, leaseStart: "2026-10-01" } }),
      ),
      await record(`application.propertyId: "${VICTIM_HOUSE}"`, approved({ application: { propertyId: VICTIM_HOUSE } })),
    ];
    for (const r of refusals) {
      expect(r.status).toBe(403);
      expect(r.stored).toBe(false);
    }

    const own = await record(
      `names only ${OWN_HOUSE} (the writer's own house)`,
      approved({ assignedPropertyId: OWN_HOUSE, assignedRoomChoice: `${OWN_HOUSE}::room-1`, application: { roomChoice1: `${OWN_HOUSE}::room-1` } }),
    );
    expect(own.status).toBe(200);
    expect(own.stored).toBe(true);

    EDIT_GRANTS[ATTACKER] = [VICTIM_HOUSE];
    const granted = await record(
      `names ${VICTIM_HOUSE}, writer holds an edit grant on it`,
      approved({ assignedPropertyId: VICTIM_HOUSE, assignedRoomChoice: `${VICTIM_HOUSE}::room-1` }),
    );
    expect(granted.status).toBe(200);
    say();
  });

  it("re-checks every house the row names when it is moved to approved", async () => {
    const named = { assignedPropertyId: VICTIM_HOUSE, assignedRoomChoice: `${VICTIM_HOUSE}::room-1` };
    STORED = [
      {
        id: "AXIS-PLANT1",
        manager_user_id: ATTACKER,
        property_id: OWN_HOUSE,
        assigned_property_id: VICTIM_HOUSE,
        row_data: { id: "AXIS-PLANT1", email: "planted@example.com", bucket: "pending", propertyId: OWN_HOUSE, ...named },
      },
    ];
    say("2. Approval re-checks the houses, even when the stored row already named them");
    const res = await record(`stored row already names ${VICTIM_HOUSE} · bucket -> approved`, approved({ bucket: "approved", manuallyAdded: false, ...named }));
    expect(res.status).toBe(403);
    expect(res.stored).toBe(false);
    say();
  });

  it("refuses an applicant account filing itself as a resident slot", async () => {
    ROLE = "resident";
    say("3. An applicant account cannot file itself as a resident slot");
    const res = await record(
      "signed in as a resident · bucket approved + manualResidentDetails",
      approved({ email: "mgr@test.local", assignedPropertyId: VICTIM_HOUSE, assignedRoomChoice: `${VICTIM_HOUSE}::room-1` }),
    );
    expect(res.status).toBe(403);
    expect(res.stored).toBe(false);
    say();
  });
});

describe("evidence · an applicant never sets their own placement", () => {
  it("strips a client-supplied placement and a room choice naming another house", async () => {
    const { prepareGuestApplicationUpsert } = await import("@/lib/auth/guest-application-upsert");
    const LISTING = "listing-own";
    const db = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { manager_user_id: OWNER, status: "live", property_data: {} }, error: null }) }) }),
      }),
    } as never;
    const sent = {
      id: "AXIS-GUEST1",
      name: "Gus Guest",
      email: "gus@example.com",
      bucket: "pending",
      propertyId: LISTING,
      stage: "Submitted",
      detail: "",
      assignedPropertyId: VICTIM_HOUSE,
      assignedRoomChoice: `${VICTIM_HOUSE}::room-1`,
      application: { propertyId: LISTING, roomChoice1: `${LISTING}::room-1`, roomChoice2: `${VICTIM_HOUSE}::room-1` },
    } as unknown as DemoApplicantRow;

    const result = await prepareGuestApplicationUpsert(db, { row: sent });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const application = result.row.application as unknown as Record<string, string>;

    say("4. What the applicant's own browser sent vs what the server stored");
    say(`     sent   assignedPropertyId=${VICTIM_HOUSE} assignedRoomChoice=${VICTIM_HOUSE}::room-1`);
    say(`            roomChoice1=${LISTING}::room-1 roomChoice2=${VICTIM_HOUSE}::room-1`);
    say(`     stored assignedPropertyId=${String(result.row.assignedPropertyId)} assignedRoomChoice=${String(result.row.assignedRoomChoice)}`);
    say(`            roomChoice1=${application.roomChoice1 || "(empty)"} roomChoice2=${application.roomChoice2 || "(empty)"}`);

    expect(result.row.assignedPropertyId).toBeUndefined();
    expect(result.row.assignedRoomChoice).toBeUndefined();
    expect(application.roomChoice1).toBe(`${LISTING}::room-1`);
    expect(application.roomChoice2).toBe("");
    say();
  });
});

describe("evidence · the manager list drops a slot a stranger filed", () => {
  it("lists only the slots the house's own people wrote", async () => {
    const HOUSE = "house-victim";
    PROPERTIES = [{ id: HOUSE, manager_user_id: OWNER }];
    LINKS = [{ inviter_user_id: OWNER, invitee_user_id: TEAMMATE, assigned_property_ids: [HOUSE], team_role: "leasing", status: "accepted" }];
    const slot = (id: string, author: string | null) => ({
      id,
      row_data: { id, name: id, email: `${id.toLowerCase()}@example.com`, bucket: "approved", manuallyAdded: true, stage: "Active", detail: "" },
      manager_user_id: author,
      property_id: author === OWNER || author === TEAMMATE || author === null ? HOUSE : "house-stranger",
      assigned_property_id: HOUSE,
      updated_at: "2026-07-01T00:00:00.000Z",
    });
    STORED = [slot("AXIS-PLANT", "mgr-stranger"), slot("AXIS-OWNER", OWNER), slot("AXIS-TEAM", TEAMMATE), slot("AXIS-LEGACY", null)];
    getUser.mockResolvedValue({ data: { user: { id: OWNER, email: "o@test.local", user_metadata: {} } }, error: null });

    const { GET } = await import("@/app/api/manager-applications/route");
    const res = await GET(new Request("https://example.test/api/manager-applications"));
    expect(res.status).toBe(200);
    const rows = ((await res.json()) as { rows: { id: string }[] }).rows.map((r) => r.id).sort();

    say("5. GET /api/manager-applications — the Residents list and Bookings grid read this");
    say(`     rows in the table : AXIS-PLANT (by mgr-stranger), AXIS-OWNER (by ${OWNER}), AXIS-TEAM (by ${TEAMMATE}), AXIS-LEGACY (unstamped)`);
    say(`     HTTP ${res.status} returned: ${rows.join(", ")}`);
    say("     AXIS-PLANT is absent — the stranger's slot never reaches the owner's list.");
    expect(rows).toEqual(["AXIS-LEGACY", "AXIS-OWNER", "AXIS-TEAM"]);

    if (OUT) {
      mkdirSync(OUT, { recursive: true });
      writeFileSync(`${OUT}/security-applications.txt`, `${log.join("\n")}\n`);
    }
  });
});
