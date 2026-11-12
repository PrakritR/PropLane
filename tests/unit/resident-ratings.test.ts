import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Resident ratings (docs/agents/resident-ratings.md): who may rate, one per residency, what a future manager sees,
 * the resident's response and dispute, the purge classification, and that no client role touches the table.
 * The server half runs against a small in-memory stand-in for the service-role client, so the rules under test are
 * the real ones (`ratings.server.ts`), with the authorization primitives mocked at their module seam.
 */

const admin = vi.hoisted(() => ({ isAdminUser: vi.fn(async () => false) }));
const access = vi.hoisted(() => ({ managerCanAccessApplicationRecord: vi.fn(async () => true) }));
const scope = vi.hoisted(() => ({
  managerHasCoManagerPermissionForProperty: vi.fn(async (...args: unknown[]) => args.length >= 0),
}));
const inbox = vi.hoisted(() => ({
  deliverPortalMessageToAdminSharedInbox: vi.fn(async (...args: unknown[]) => ({ threadId: `admin_portal_${args.length}`, created: true })),
}));

vi.mock("@/lib/auth/admin-preview", () => admin);
vi.mock("@/lib/auth/manager-application-access", () => access);
vi.mock("@/lib/auth/manager-lease-scope", () => scope);
vi.mock("@/lib/admin-shared-inbox.server", () => inbox);

import {
  disputeResidentRating,
  listRatingsForResident,
  loadManagerRatingsView,
  resolveRatingDispute,
  saveManagerRating,
  saveResidentResponse,
} from "@/lib/resident-ratings/ratings.server";
import {
  RATING_RESPONSE_MAX,
  RATING_REVIEW_MAX,
  assessResidency,
  isSubmittedApplicantRow,
  parseRatingInput,
  summarizeRatings,
} from "@/lib/resident-ratings/ratings";
import {
  hasCoManagerPermissionLevel,
} from "@/lib/co-manager-permissions";
import { stampTeamRolePermissions } from "@/lib/co-manager-team-roles";

/* ------------------------------ in-memory db ------------------------------ */

type Row = Record<string, unknown>;

function fakeDb(seed: Record<string, Row[]>) {
  const tables: Record<string, Row[]> = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((row) => ({ ...row }));
  let counter = 0;

  class Query implements PromiseLike<{ data: unknown; error: unknown }> {
    private op: "select" | "insert" | "update" | "delete" = "select";
    private payload: Row = {};
    private filters: Array<(row: Row) => boolean> = [];
    private returning = false;
    private max = Infinity;
    constructor(private table: string) {}
    select() {
      if (this.op !== "select") this.returning = true;
      return this;
    }
    insert(payload: Row) {
      this.op = "insert";
      this.payload = payload;
      return this;
    }
    update(payload: Row) {
      this.op = "update";
      this.payload = payload;
      return this;
    }
    delete() {
      this.op = "delete";
      return this;
    }
    eq(column: string, value: unknown) {
      this.filters.push((row) => row[column] === value);
      return this;
    }
    in(column: string, values: unknown[]) {
      this.filters.push((row) => values.includes(row[column]));
      return this;
    }
    order() {
      return this;
    }
    limit(n: number) {
      this.max = n;
      return this;
    }
    private run(): { data: unknown; error: unknown } {
      const rows = (tables[this.table] ??= []);
      const matching = () => rows.filter((row) => this.filters.every((f) => f(row)));
      if (this.op === "insert") {
        if (this.table === "resident_ratings") {
          const clash = rows.some(
            (row) => row.residency_ref === this.payload.residency_ref && row.workspace_id === this.payload.workspace_id,
          );
          if (clash) return { data: null, error: { code: "23505", message: "duplicate key" } };
        }
        counter += 1;
        const now = "2026-11-12T10:00:00.000Z";
        const row: Row = {
          id: `00000000-0000-4000-8000-${String(counter).padStart(12, "0")}`,
          review: "",
          resident_response: null,
          response_at: null,
          disputed_at: null,
          dispute_resolved_at: null,
          created_at: now,
          updated_at: now,
          ...this.payload,
        };
        rows.push(row);
        return { data: this.returning ? [row] : null, error: null };
      }
      if (this.op === "update") {
        const hit = matching();
        for (const row of hit) Object.assign(row, this.payload);
        return { data: this.returning ? hit : null, error: null };
      }
      if (this.op === "delete") {
        const hit = new Set(matching());
        tables[this.table] = rows.filter((row) => !hit.has(row));
        return { data: null, error: null };
      }
      return { data: matching().slice(0, this.max), error: null };
    }
    maybeSingle() {
      const result = this.run();
      const list = (result.data as Row[] | null) ?? [];
      return Promise.resolve({ data: list[0] ?? null, error: result.error });
    }
    then<T1, T2>(
      onfulfilled?: ((value: { data: unknown; error: unknown }) => T1 | PromiseLike<T1>) | null,
      onrejected?: ((reason: unknown) => T2 | PromiseLike<T2>) | null,
    ) {
      return Promise.resolve(this.run()).then(onfulfilled, onrejected);
    }
  }

  return {
    tables,
    from(table: string) {
      return new Query(table);
    },
  };
}

/* --------------------------------- fixtures -------------------------------- */

const RESIDENT = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
const TEAMMATE = "33333333-3333-4333-8333-333333333333";
const OTHER_MANAGER = "44444444-4444-4444-8444-444444444444";
const WS_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WS_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const EMAIL = "tenant@example.com";

function application(overrides: Row = {}, rowData: Row = {}): Row {
  return {
    id: "AXIS-1001",
    manager_user_id: OWNER,
    resident_email: EMAIL,
    property_id: "prop-a",
    assigned_property_id: "prop-a",
    row_data: {
      bucket: "approved",
      stage: "Approved",
      email: EMAIL,
      residentUserId: RESIDENT,
      propertyId: "prop-a",
      application: { fullLegalName: "Tia Tenant", leaseStart: "2026-01-01" },
      ...rowData,
    },
    ...overrides,
  };
}

function executedLease(overrides: Row = {}): Row {
  return {
    id: "lease-1",
    property_id: "prop-a",
    row_data: {
      id: "lease-1",
      residentEmail: EMAIL,
      axisId: "AXIS-1001",
      status: "Fully Signed",
      fullySignedAt: "2026-01-02T00:00:00.000Z",
      ...overrides,
    },
  };
}

function baseSeed(extra: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    manager_application_records: [application()],
    manager_property_records: [
      {
        id: "prop-a",
        workspace_id: WS_A,
        property_data: { listingSubmission: { city: "Seattle", address: "5257 Brooklyn Ave NE" } },
      },
      { id: "prop-b", workspace_id: WS_B, property_data: { listingSubmission: { city: "Tacoma", address: "1 Secret St" } } },
    ],
    profiles: [{ id: RESIDENT, email: EMAIL, full_name: "Tia Tenant" }],
    portal_lease_pipeline_records: [executedLease()],
    resident_ratings: [],
    ...extra,
  };
}

type Db = Parameters<typeof saveManagerRating>[0];
const asDb = (db: ReturnType<typeof fakeDb>) => db as unknown as Db;

beforeEach(() => {
  admin.isAdminUser.mockReset().mockResolvedValue(false);
  access.managerCanAccessApplicationRecord.mockReset().mockResolvedValue(true);
  scope.managerHasCoManagerPermissionForProperty.mockReset().mockResolvedValue(true);
  inbox.deliverPortalMessageToAdminSharedInbox.mockReset().mockResolvedValue({ threadId: "admin_portal_x", created: true });
});

/* ---------------------------------- pure ---------------------------------- */

describe("rating input and residency rules (pure)", () => {
  it("requires 1-5 whole stars and caps the review", () => {
    expect(parseRatingInput({ stars: 0 }).ok).toBe(false);
    expect(parseRatingInput({ stars: 6 }).ok).toBe(false);
    expect(parseRatingInput({ stars: 3.5 }).ok).toBe(false);
    expect(parseRatingInput({}).ok).toBe(false);
    expect(parseRatingInput({ stars: 5, review: "x".repeat(RATING_REVIEW_MAX + 1) }).ok).toBe(false);
    expect(parseRatingInput({ stars: 4, review: "  Great tenant  " })).toEqual({ ok: true, value: { stars: 4, review: "Great tenant" } });
  });

  it("drops every identity the body carries", () => {
    const parsed = parseRatingInput({ stars: 5, review: "ok", residentUserId: "x", workspaceId: "y", raterUserId: "z" });
    expect(parsed).toEqual({ ok: true, value: { stars: 5, review: "ok" } });
  });

  it("an approved application alone is not a stay; a signed lease, a booking or a manual tenancy is", () => {
    const approved = { bucket: "approved", application: {} };
    expect(assessResidency(approved, { leaseExecuted: false })).toEqual({ ok: false, reason: "no_lease_or_stay" });
    expect(assessResidency(approved, { leaseExecuted: true })).toEqual({ ok: true });
    expect(assessResidency({ ...approved, manuallyAdded: true }, { leaseExecuted: false })).toEqual({ ok: true });
    expect(assessResidency({ ...approved, bookingResidency: true }, { leaseExecuted: false })).toEqual({ ok: true });
    expect(assessResidency({ bucket: "pending" }, { leaseExecuted: true })).toEqual({ ok: false, reason: "not_approved" });
    expect(assessResidency({ ...approved, smsLead: true }, { leaseExecuted: true }).ok).toBe(false);
    expect(assessResidency({ ...approved, withdrawnAt: "2026-01-01" }, { leaseExecuted: true }).ok).toBe(false);
  });

  it("a move-in date still ahead is not a stay yet", () => {
    const facts = { bucket: "approved", leaseStart: "2027-01-01" };
    expect(assessResidency(facts, { leaseExecuted: true, today: "2026-11-12" })).toEqual({ ok: false, reason: "not_started" });
    expect(assessResidency(facts, { leaseExecuted: true, today: "2027-01-01" })).toEqual({ ok: true });
  });

  it("only an applicant's own submission opens another workspace's ratings", () => {
    const submitted = { bucket: "pending", stage: "Pending review", application: { a: 1 } };
    expect(isSubmittedApplicantRow(submitted)).toBe(true);
    expect(isSubmittedApplicantRow({ ...submitted, bucket: "rejected" })).toBe(true);
    expect(isSubmittedApplicantRow({ ...submitted, stage: "In progress" })).toBe(false);
    expect(isSubmittedApplicantRow({ ...submitted, manuallyAdded: true })).toBe(false);
    expect(isSubmittedApplicantRow({ ...submitted, smsLead: true })).toBe(false);
    expect(isSubmittedApplicantRow({ ...submitted, withdrawnAt: "2026-11-01" })).toBe(false);
    expect(isSubmittedApplicantRow({ bucket: "pending", stage: "Pending review" })).toBe(false);
  });

  it("summarizes the average to one decimal", () => {
    expect(summarizeRatings([])).toEqual({ average: null, count: 0 });
    expect(summarizeRatings([{ stars: 5 }, { stars: 4 }, { stars: 4 }])).toEqual({ average: 4.3, count: 3 });
  });
});

/* ------------------------------ rate permission ---------------------------- */

describe("rate permission", () => {
  it("a workspace that housed the resident rates them; every identity is derived, never taken from the body", async () => {
    const db = fakeDb(baseSeed());
    const result = await saveManagerRating(asDb(db), OWNER, "AXIS-1001", {
      stars: 5,
      review: "Paid early, kept the house spotless.",
      residentUserId: "99999999-9999-4999-8999-999999999999",
      workspaceId: WS_B,
      raterUserId: OTHER_MANAGER,
      residencyRef: "AXIS-9999",
    });
    expect(result.ok).toBe(true);
    expect(db.tables.resident_ratings).toHaveLength(1);
    expect(db.tables.resident_ratings[0]).toMatchObject({
      resident_user_id: RESIDENT,
      rater_user_id: OWNER,
      workspace_id: WS_A,
      residency_ref: "AXIS-1001",
      house_city: "Seattle",
      stars: 5,
    });
  });

  it("refuses without a real residency: an approved application with no signed lease", async () => {
    const db = fakeDb(baseSeed({ portal_lease_pipeline_records: [] }));
    const result = await saveManagerRating(asDb(db), OWNER, "AXIS-1001", { stars: 4 });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(db.tables.resident_ratings).toHaveLength(0);
  });

  it("refuses a pending applicant even with a lease on file elsewhere", async () => {
    const db = fakeDb(baseSeed({ manager_application_records: [application({}, { bucket: "pending", stage: "Pending review" })] }));
    expect(await saveManagerRating(asDb(db), OWNER, "AXIS-1001", { stars: 4 })).toMatchObject({ ok: false, status: 409 });
  });

  it("a lease for another person on the same house is not this person's residency", async () => {
    const db = fakeDb(
      baseSeed({ portal_lease_pipeline_records: [executedLease({ residentEmail: "someone@else.com", axisId: "AXIS-2002" })] }),
    );
    expect(await saveManagerRating(asDb(db), OWNER, "AXIS-1001", { stars: 4 })).toMatchObject({ ok: false, status: 409 });
  });

  it("a manager-onboarded tenant (manuallyAdded) with a proven account counts as a stay", async () => {
    const db = fakeDb(
      baseSeed({ manager_application_records: [application({}, { manuallyAdded: true })], portal_lease_pipeline_records: [] }),
    );
    expect(await saveManagerRating(asDb(db), OWNER, "AXIS-1001", { stars: 3 })).toMatchObject({ ok: true });
  });

  it("a Viewer seat cannot rate: Residents must be granted at edit on this house", async () => {
    // The role matrix itself: Viewer reads every module and edits none; Property manager edits Residents.
    const viewer = stampTeamRolePermissions("viewer");
    expect(hasCoManagerPermissionLevel(viewer!, "residents", "read")).toBe(true);
    expect(hasCoManagerPermissionLevel(viewer!, "residents", "edit")).toBe(false);
    expect(hasCoManagerPermissionLevel(stampTeamRolePermissions("property_manager")!, "residents", "edit")).toBe(true);

    scope.managerHasCoManagerPermissionForProperty.mockResolvedValue(false);
    const db = fakeDb(baseSeed());
    const result = await saveManagerRating(asDb(db), TEAMMATE, "AXIS-1001", { stars: 5 });
    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(db.tables.resident_ratings).toHaveLength(0);
    // The gate asked the Residents module at EDIT, on the house re-derived from the record, strictly.
    expect(scope.managerHasCoManagerPermissionForProperty).toHaveBeenCalledWith(
      expect.anything(),
      TEAMMATE,
      "prop-a",
      "residents",
      "edit",
      { strict: true },
    );
  });

  it("a co-manager with Residents at edit can rate", async () => {
    const db = fakeDb(baseSeed());
    expect(await saveManagerRating(asDb(db), TEAMMATE, "AXIS-1001", { stars: 4 })).toMatchObject({ ok: true });
    expect(db.tables.resident_ratings[0]).toMatchObject({ rater_user_id: TEAMMATE, workspace_id: WS_A });
  });

  it("a manager with no access to the record is refused before anything is read about the resident", async () => {
    access.managerCanAccessApplicationRecord.mockResolvedValue(false);
    const db = fakeDb(baseSeed());
    expect(await saveManagerRating(asDb(db), OTHER_MANAGER, "AXIS-1001", { stars: 5 })).toMatchObject({ ok: false, status: 403 });
    expect(db.tables.resident_ratings).toHaveLength(0);
  });

  it("the property is re-authorized without the record's frozen manager stamp", async () => {
    // Record access passes (stamped to this manager) but the house in row_data belongs to someone else.
    access.managerCanAccessApplicationRecord.mockImplementation(async (...args: unknown[]) => {
      const record = args[2] as { manager_user_id?: string };
      return Boolean(record.manager_user_id);
    });
    const db = fakeDb(baseSeed());
    const result = await saveManagerRating(asDb(db), OWNER, "AXIS-1001", { stars: 5 });
    expect(result).toMatchObject({ ok: false, status: 403 });
  });

  it("a platform admin reading as oversight cannot rate", async () => {
    admin.isAdminUser.mockResolvedValue(true);
    const db = fakeDb(baseSeed());
    expect(await saveManagerRating(asDb(db), OWNER, "AXIS-1001", { stars: 5 })).toMatchObject({ ok: false, status: 403 });
  });

  it("a record whose claimed resident account does not carry the record's email binds to no one", async () => {
    const db = fakeDb(baseSeed({ profiles: [{ id: RESIDENT, email: "someone-else@example.com" }] }));
    const result = await saveManagerRating(asDb(db), OWNER, "AXIS-1001", { stars: 5 });
    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(db.tables.resident_ratings).toHaveLength(0);
  });

  it("rejects a malformed id and invalid stars before any write", async () => {
    const db = fakeDb(baseSeed());
    expect(await saveManagerRating(asDb(db), OWNER, "AXIS-1001", { stars: 9 })).toMatchObject({ ok: false, status: 422 });
    expect(await saveManagerRating(asDb(db), OWNER, "../etc", { stars: 5 })).toMatchObject({ ok: false, status: 404 });
  });
});

/* ------------------------------ one per residency -------------------------- */

describe("one rating per residency", () => {
  it("a second save by the rater edits the same row", async () => {
    const db = fakeDb(baseSeed());
    await saveManagerRating(asDb(db), OWNER, "AXIS-1001", { stars: 2, review: "Late twice." });
    await saveManagerRating(asDb(db), OWNER, "AXIS-1001", { stars: 4, review: "Improved a lot." });
    expect(db.tables.resident_ratings).toHaveLength(1);
    expect(db.tables.resident_ratings[0]).toMatchObject({ stars: 4, review: "Improved a lot.", rater_user_id: OWNER });
  });

  it("editing keeps the resident's response", async () => {
    const db = fakeDb(baseSeed());
    await saveManagerRating(asDb(db), OWNER, "AXIS-1001", { stars: 2 });
    const id = String(db.tables.resident_ratings[0]!.id);
    await saveResidentResponse(asDb(db), RESIDENT, id, { response: "I had a family emergency." });
    await saveManagerRating(asDb(db), OWNER, "AXIS-1001", { stars: 3 });
    expect(db.tables.resident_ratings[0]).toMatchObject({ stars: 3, resident_response: "I had a family emergency." });
  });

  it("a teammate cannot overwrite the rater's rating; the house owner can", async () => {
    const db = fakeDb(baseSeed());
    await saveManagerRating(asDb(db), TEAMMATE, "AXIS-1001", { stars: 5 });
    const byOtherTeammate = await saveManagerRating(asDb(db), "55555555-5555-4555-8555-555555555555", "AXIS-1001", { stars: 1 });
    expect(byOtherTeammate).toMatchObject({ ok: false, status: 409 });
    expect(db.tables.resident_ratings[0]).toMatchObject({ stars: 5, rater_user_id: TEAMMATE });
    expect(await saveManagerRating(asDb(db), OWNER, "AXIS-1001", { stars: 4 })).toMatchObject({ ok: true });
    expect(db.tables.resident_ratings).toHaveLength(1);
  });

  it("a rating whose rater's login is gone can be taken over by an authorized rater", async () => {
    const db = fakeDb(baseSeed());
    await saveManagerRating(asDb(db), TEAMMATE, "AXIS-1001", { stars: 5 });
    db.tables.resident_ratings![0]!.rater_user_id = null;
    expect(await saveManagerRating(asDb(db), "55555555-5555-4555-8555-555555555555", "AXIS-1001", { stars: 3 })).toMatchObject({ ok: true });
    expect(db.tables.resident_ratings[0]!.rater_user_id).toBe("55555555-5555-4555-8555-555555555555");
  });

  it("a concurrent second insert loses to the unique (residency_ref, workspace_id) index with a 409", async () => {
    const db = fakeDb(baseSeed());
    // The race: the read sees nothing, then the other writer's row lands before this insert.
    const realFrom = db.from.bind(db);
    let first = true;
    db.from = (table: string) => {
      const query = realFrom(table);
      if (table === "resident_ratings" && first) {
        first = false;
        db.tables.resident_ratings!.push({
          id: "00000000-0000-4000-8000-0000000000ff",
          residency_ref: "AXIS-1001",
          workspace_id: WS_A,
          resident_user_id: RESIDENT,
          rater_user_id: TEAMMATE,
          stars: 5,
          review: "",
        });
        // Hide the row from the pre-insert read only.
        const originalMaybeSingle = query.maybeSingle.bind(query);
        query.maybeSingle = () => originalMaybeSingle().then(() => ({ data: null, error: null }));
      }
      return query;
    };
    expect(await saveManagerRating(asDb(db), OWNER, "AXIS-1001", { stars: 1 })).toMatchObject({ ok: false, status: 409 });
  });

  it("the migration backs it with a unique index and bounds the columns", () => {
    const sql = migration();
    expect(sql).toMatch(/create unique index if not exists resident_ratings_residency_workspace_idx\s+on public\.resident_ratings \(residency_ref, workspace_id\)/);
    expect(sql).toMatch(/stars smallint not null check \(stars between 1 and 5\)/);
    expect(sql).toMatch(/char_length\(review\) <= 1000/);
    expect(sql).toMatch(/char_length\(resident_response\) <= 500/);
  });
});

/* ------------------------- future-manager visibility ----------------------- */

describe("what a future manager sees", () => {
  /** Workspace A rated Tia; workspace B (another manager) now reviews her application on its own house. */
  function futureManagerSeed(applicationRowData: Row = {}) {
    return baseSeed({
      manager_application_records: [
        application({}, {}),
        application(
          { id: "AXIS-2002", manager_user_id: OTHER_MANAGER, property_id: "prop-b", assigned_property_id: "prop-b" },
          { bucket: "pending", stage: "Pending review", propertyId: "prop-b", ...applicationRowData },
        ),
      ],
      resident_ratings: [
        {
          id: "00000000-0000-4000-8000-0000000000a1",
          resident_user_id: RESIDENT,
          rater_user_id: OWNER,
          workspace_id: WS_A,
          residency_ref: "AXIS-1001",
          house_city: "Seattle",
          stars: 5,
          review: "Paid early, kept the house spotless.",
          resident_response: "Thank you!",
          disputed_at: null,
          dispute_resolved_at: null,
          created_at: "2026-03-15T09:00:00.000Z",
          updated_at: "2026-03-15T09:00:00.000Z",
        },
        {
          id: "00000000-0000-4000-8000-0000000000a2",
          resident_user_id: RESIDENT,
          rater_user_id: TEAMMATE,
          workspace_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
          residency_ref: "AXIS-3003",
          house_city: "Tacoma",
          stars: 3,
          review: "Fine.",
          resident_response: null,
          disputed_at: "2026-04-01T00:00:00.000Z",
          dispute_resolved_at: null,
          created_at: "2026-04-10T09:00:00.000Z",
          updated_at: "2026-04-10T09:00:00.000Z",
        },
      ],
    });
  }

  it("shows average, count and each review on an application the person submitted to this workspace", async () => {
    const db = fakeDb(futureManagerSeed());
    const result = await loadManagerRatingsView(asDb(db), OTHER_MANAGER, "AXIS-2002");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.view.available).toBe(true);
    expect(result.view.summary).toEqual({ average: 4, count: 2 });
    expect(result.view.ratings.map((r) => ({ stars: r.stars, review: r.review, monthYear: r.monthYear, city: r.city, response: r.response, disputed: r.disputed }))).toEqual([
      { stars: 5, review: "Paid early, kept the house spotless.", monthYear: "March 2026", city: "Seattle", response: "Thank you!", disputed: false },
      { stars: 3, review: "Fine.", monthYear: "April 2026", city: "Tacoma", response: null, disputed: true },
    ]);
    // The future manager did not write either of these.
    expect(result.view.ratings.every((r) => r.own === false)).toBe(true);
    expect(result.view.canRate).toBe(false);
  });

  it("leaks no workspace, rater, resident id, name or address", async () => {
    const db = fakeDb(futureManagerSeed());
    const result = await loadManagerRatingsView(asDb(db), OTHER_MANAGER, "AXIS-2002");
    const wire = JSON.stringify(result);
    for (const secret of [OWNER, TEAMMATE, RESIDENT, WS_A, WS_B, "cccccccc", "Tia", "5257 Brooklyn", "1 Secret", "AXIS-1001", "AXIS-3003", EMAIL]) {
      expect(wire, secret).not.toContain(secret);
    }
    const keys = new Set((result as { view: { ratings: object[] } }).view.ratings.flatMap((r) => Object.keys(r)));
    expect([...keys].sort()).toEqual(["city", "disputed", "monthYear", "own", "response", "review", "stars"]);
  });

  it("a resolved dispute no longer reads as disputed", async () => {
    const db = fakeDb(futureManagerSeed());
    db.tables.resident_ratings![1]!.dispute_resolved_at = "2026-05-01T00:00:00.000Z";
    const result = await loadManagerRatingsView(asDb(db), OTHER_MANAGER, "AXIS-2002");
    if (!result.ok) throw new Error("expected ok");
    expect(result.view.ratings.some((r) => r.disputed)).toBe(false);
  });

  it("shows nothing on a manager-entered row that is not a residency, an unfinished draft, or an application never submitted", async () => {
    for (const rowData of [
      { manuallyAdded: true },
      { stage: "In progress" },
      { application: undefined },
      { smsLead: true },
      { withdrawnAt: "2026-11-01T00:00:00.000Z" },
    ]) {
      const db = fakeDb(futureManagerSeed(rowData));
      const result = await loadManagerRatingsView(asDb(db), OTHER_MANAGER, "AXIS-2002");
      expect(result.ok && result.view.available, JSON.stringify(rowData)).toBe(false);
      expect(result.ok && result.view.ratings, JSON.stringify(rowData)).toEqual([]);
    }
  });

  it("shows nothing when the record's resident account cannot be proven (a typed-in email is not an identity)", async () => {
    const db = fakeDb({ ...futureManagerSeed(), profiles: [{ id: RESIDENT, email: "different@example.com" }] });
    const result = await loadManagerRatingsView(asDb(db), OTHER_MANAGER, "AXIS-2002");
    expect(result.ok && result.view.available).toBe(false);
    expect(JSON.stringify(result)).not.toContain("Paid early");
  });

  it("a manager with no access to that application gets a refusal, not the ratings", async () => {
    access.managerCanAccessApplicationRecord.mockResolvedValue(false);
    const db = fakeDb(futureManagerSeed());
    expect(await loadManagerRatingsView(asDb(db), "66666666-6666-4666-8666-666666666666", "AXIS-2002")).toMatchObject({ ok: false, status: 403 });
  });

  it("the rating's own workspace sees its rating flagged own and can edit it; a Viewer sees ratings but cannot rate", async () => {
    const db = fakeDb(futureManagerSeed());
    const owner = await loadManagerRatingsView(asDb(db), OWNER, "AXIS-1001");
    if (!owner.ok) throw new Error("expected ok");
    expect(owner.view.own).toEqual({ stars: 5, review: "Paid early, kept the house spotless." });
    expect(owner.view.ratings[0]!.own).toBe(true);
    expect(owner.view.canRate).toBe(true);

    scope.managerHasCoManagerPermissionForProperty.mockResolvedValue(false);
    const viewer = await loadManagerRatingsView(asDb(db), TEAMMATE, "AXIS-1001");
    if (!viewer.ok) throw new Error("expected ok");
    expect(viewer.view.available).toBe(true);
    expect(viewer.view.canRate).toBe(false);
  });
});

/* ------------------------- resident response and dispute -------------------- */

describe("resident response and dispute", () => {
  function rated() {
    const db = fakeDb(baseSeed());
    return saveManagerRating(asDb(db), OWNER, "AXIS-1001", { stars: 2, review: "Late." }).then(() => ({
      db,
      id: String(db.tables.resident_ratings![0]!.id),
    }));
  }

  it("the resident sees their own ratings and nobody else's", async () => {
    const { db } = await rated();
    expect(await listRatingsForResident(asDb(db), RESIDENT)).toHaveLength(1);
    expect(await listRatingsForResident(asDb(db), OTHER_MANAGER)).toEqual([]);
    expect(JSON.stringify(await listRatingsForResident(asDb(db), RESIDENT))).not.toContain(OWNER);
  });

  it("adds, edits and clears one public response, capped at 500 characters", async () => {
    const { db, id } = await rated();
    const saved = await saveResidentResponse(asDb(db), RESIDENT, id, { response: "  The rent was late once.  " });
    expect(saved).toMatchObject({ ok: true, rating: { response: "The rent was late once." } });
    expect(db.tables.resident_ratings![0]!.response_at).toBeTruthy();
    await saveResidentResponse(asDb(db), RESIDENT, id, { response: "Edited." });
    expect(db.tables.resident_ratings![0]!.resident_response).toBe("Edited.");
    expect(await saveResidentResponse(asDb(db), RESIDENT, id, { response: "x".repeat(RATING_RESPONSE_MAX + 1) })).toMatchObject({ ok: false, status: 422 });
    await saveResidentResponse(asDb(db), RESIDENT, id, { response: "" });
    expect(db.tables.resident_ratings![0]).toMatchObject({ resident_response: null, response_at: null });
  });

  it("the response shows to a future manager beside the review", async () => {
    const { db, id } = await rated();
    await saveResidentResponse(asDb(db), RESIDENT, id, { response: "It was a bank holiday." });
    db.tables.manager_application_records!.push(
      application({ id: "AXIS-2002", manager_user_id: OTHER_MANAGER, property_id: "prop-b", assigned_property_id: "prop-b" }, { bucket: "pending", stage: "Pending review" }),
    );
    const view = await loadManagerRatingsView(asDb(db), OTHER_MANAGER, "AXIS-2002");
    if (!view.ok) throw new Error("expected ok");
    expect(view.view.ratings[0]).toMatchObject({ review: "Late.", response: "It was a bank holiday." });
  });

  it("a person cannot answer or dispute a rating about someone else, and a body id changes nothing", async () => {
    const { db, id } = await rated();
    expect(await saveResidentResponse(asDb(db), OTHER_MANAGER, id, { response: "hi", residentUserId: RESIDENT })).toMatchObject({ ok: false, status: 404 });
    expect(await disputeResidentRating(asDb(db), { userId: OTHER_MANAGER, email: "x@y.com", name: "X" }, id, {})).toMatchObject({ ok: false, status: 404 });
    expect(inbox.deliverPortalMessageToAdminSharedInbox).not.toHaveBeenCalled();
    expect(db.tables.resident_ratings![0]!.resident_response).toBeNull();
  });

  it("Dispute opens a PropLane support thread (one, no email), and future managers read Disputed until it is resolved", async () => {
    const { db, id } = await rated();
    db.tables.manager_application_records!.push(
      application({ id: "AXIS-2002", manager_user_id: OTHER_MANAGER, property_id: "prop-b", assigned_property_id: "prop-b" }, { bucket: "pending", stage: "Pending review" }),
    );
    const resident = { userId: RESIDENT, email: EMAIL, name: "Tia Tenant" };
    const first = await disputeResidentRating(asDb(db), resident, id, { reason: "I never paid late." });
    expect(first).toMatchObject({ ok: true, alreadyDisputed: false, rating: { disputed: true } });
    expect(inbox.deliverPortalMessageToAdminSharedInbox).toHaveBeenCalledTimes(1);
    const sent = inbox.deliverPortalMessageToAdminSharedInbox.mock.calls[0]![1] as { senderEmail: string; senderRole: string; subject: string; body: string };
    expect(sent).toMatchObject({ senderEmail: EMAIL, senderRole: "resident", subject: "Rating dispute" });
    expect(sent.body).toContain("I never paid late.");
    expect(sent.body).not.toContain(OWNER);

    // Idempotent: no second thread while it is open.
    expect(await disputeResidentRating(asDb(db), resident, id, {})).toMatchObject({ ok: true, alreadyDisputed: true });
    expect(inbox.deliverPortalMessageToAdminSharedInbox).toHaveBeenCalledTimes(1);

    const view = await loadManagerRatingsView(asDb(db), OTHER_MANAGER, "AXIS-2002");
    if (!view.ok) throw new Error("expected ok");
    expect(view.view.ratings[0]!.disputed).toBe(true);

    expect(await resolveRatingDispute(asDb(db), id, "keep")).toEqual({ ok: true });
    const after = await loadManagerRatingsView(asDb(db), OTHER_MANAGER, "AXIS-2002");
    if (!after.ok) throw new Error("expected ok");
    expect(after.view.ratings[0]!.disputed).toBe(false);

    expect(await resolveRatingDispute(asDb(db), id, "remove")).toEqual({ ok: true });
    expect(db.tables.resident_ratings).toHaveLength(0);
  });

  it("a rating is never marked disputed when support could not be reached", async () => {
    const { db, id } = await rated();
    inbox.deliverPortalMessageToAdminSharedInbox.mockRejectedValueOnce(new Error("down"));
    const result = await disputeResidentRating(asDb(db), { userId: RESIDENT, email: EMAIL, name: "Tia" }, id, {});
    expect(result).toMatchObject({ ok: false, status: 502 });
    expect(db.tables.resident_ratings![0]!.disputed_at).toBeNull();
  });
});

/* --------------------------- purge classification --------------------------- */

function migration(): string {
  return readFileSync(path.join(process.cwd(), "supabase", "migrations", "20261112160000_resident_ratings.sql"), "utf8");
}

describe("purge classification", () => {
  it("deleting the resident deletes their ratings; deleting a rater keeps the rating and nulls the rater", async () => {
    const { ACCOUNT_PURGE_TABLES, ACCOUNT_PURGE_RETAINED } = await import("@/lib/auth/account-purge-manifest");
    const rule = ACCOUNT_PURGE_TABLES.find((entry) => entry.table === "resident_ratings");
    expect(rule, "resident_ratings must be classified in the purge manifest").toBeTruthy();
    expect("resident_ratings" in ACCOUNT_PURGE_RETAINED).toBe(false);
    expect(rule!.resident?.ids).toEqual(["resident_user_id"]);
    expect(rule!.manager?.detachIds).toEqual(["rater_user_id"]);
    expect(rule!.manager?.ids ?? []).toEqual([]);
  });

  it("the foreign keys agree: cascade for the resident, set null for the rater and the workspace", () => {
    const sql = migration();
    expect(sql).toMatch(/resident_user_id uuid not null references auth\.users \(id\) on delete cascade/);
    expect(sql).toMatch(/rater_user_id uuid references auth\.users \(id\) on delete set null/);
    expect(sql).toMatch(/workspace_id uuid references public\.portal_workspaces \(id\) on delete set null/);
  });
});

/* ------------------------------- RLS / grants ------------------------------- */

describe("no client access to resident_ratings", () => {
  it("enables RLS, creates no policy and revokes every privilege from anon and authenticated", () => {
    const sql = migration().replace(/--.*$/gm, "");
    expect(sql).toMatch(/alter table public\.resident_ratings enable row level security/);
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).not.toMatch(/\bgrant\b/i);
    expect(sql).toMatch(/revoke all on table public\.resident_ratings from anon, authenticated/);
    expect(sql).toMatch(/revoke insert, update, delete on table public\.resident_ratings from anon, authenticated/);
  });

  it("is additive and idempotent", () => {
    const sql = migration().replace(/--.*$/gm, "");
    expect(sql).not.toMatch(/\bdrop table\b|\bdrop column\b|\btruncate\s+(?:table\s+)?public\.|\bdelete from\b/i);
    expect(sql).toMatch(/create table if not exists public\.resident_ratings/);
    for (const index of sql.matchAll(/create (?:unique )?index (?!if not exists)/gi)) throw new Error(`non-idempotent index: ${index[0]}`);
  });

  it("no browser code reads or writes the table: only the server module does", () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSyncSafe(dir)) {
        const full = path.join(dir, entry);
        if (/\.(ts|tsx)$/.test(entry)) {
          const text = readFileSync(full, "utf8");
          if (/from\(\s*["']resident_ratings["']\s*\)/.test(text) && !full.endsWith("ratings.server.ts")) offenders.push(full);
        } else if (!entry.includes(".")) walk(full);
      }
    };
    walk(path.join(process.cwd(), "src"));
    expect(offenders).toEqual([]);
  });
});

function readdirSyncSafe(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

/* ---------------------------- surfaces and disclosure ----------------------- */

describe("surfaces", () => {
  const read = (file: string) => readFileSync(path.join(process.cwd(), file), "utf8");

  it("the screening disclosure carries the ratings line, once", async () => {
    const { FCRA_DISCLOSURE_TEXT } = await import("@/lib/screening/applicant-screening");
    const { RATINGS_DISCLOSURE_LINE } = await import("@/lib/resident-ratings/ratings");
    expect(RATINGS_DISCLOSURE_LINE).toBe("Managers you apply to can see ratings from your past PropLane stays.");
    expect(FCRA_DISCLOSURE_TEXT.split(RATINGS_DISCLOSURE_LINE)).toHaveLength(2);
  });

  it("Rate is a star icon between Edit and Delete, for a tenant", async () => {
    const { withResidentRateAction } = await import("@/lib/resident-record-section-actions");
    const { recordSections } = await import("@/lib/portals/record-sections");
    const base = recordSections("manager", "resident", { basePath: "/portal" }).headerActions;
    const withRate = withResidentRateAction(base);
    expect(withRate.map((a) => a.id)).toEqual(["edit", "rate", "delete"]);
    expect(withRate.find((a) => a.id === "rate")).toMatchObject({ label: "Rate" });
    expect(withResidentRateAction(withRate)).toBe(withRate);
  });

  it("the record page wires Rate and the ratings card, and the routes read only stars and review from the body", () => {
    const residents = read("src/components/portal/pro-residents.tsx");
    expect(residents).toContain("withResidentRateAction(residentRegistryHeaderActions)");
    expect(residents).toContain('case "rate":');
    expect(residents).toContain("<ResidentRatingSheet");
    expect(residents).toContain("<ManagerResidentRatingsSection");
    const route = read("src/app/api/manager-applications/[id]/ratings/route.ts");
    expect(route).not.toMatch(/body\??\.(residentUserId|workspaceId|raterUserId|userId)/);
    expect(read("src/components/portal/resident-rating-sheet.tsx")).toContain("JSON.stringify({ stars, review })");
  });

  it("the rating surfaces draw plain facts with a glyph: no Badge, no pill, no icon-less status chip", () => {
    for (const file of [
      "src/components/portal/manager-resident-ratings-section.tsx",
      "src/components/portal/resident-ratings-settings.tsx",
      "src/components/portal/rating-stars.tsx",
      "src/components/portal/resident-rating-sheet.tsx",
    ]) {
      const text = read(file);
      expect(text, file).not.toMatch(/\bBadge\b/);
      expect(text, file).not.toMatch(/rounded-full[^"]*\bbg-/);
    }
  });

  it("the resident's profile shows the ratings card and routes Dispute to support", () => {
    expect(read("src/components/portal/resident-profile-panel.tsx")).toContain("<ResidentRatingsSettings />");
    const settings = read("src/components/portal/resident-ratings-settings.tsx");
    expect(settings).toContain("Dispute");
    expect(settings).toContain('"dispute"');
  });
});
