import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";

/**
 * Server-side money-path guard for PATCH /api/portal/resident-approval.
 *
 * A resident-withdrawn application keeps `bucket === "pending"` — it only gets a
 * neutral "Withdrawn" stamp — so the manager UI could still surface Approve on it
 * (fixed separately). Approving it flips the resident profile's
 * `application_approved` flag (account provisioning) for someone who explicitly
 * pulled out. The manager UI now hides Approve for withdrawn rows, but the UI is
 * not a security boundary: this route must reject the approval on its own,
 * scoped to the acting manager's own record.
 */

type StoredRecord = {
  id: string;
  row_data: DemoApplicantRow | null;
  resident_email: string;
  manager_user_id?: string | null;
  property_id?: string | null;
  assigned_property_id?: string | null;
};

const getUser = vi.fn();
const smsNotify = vi.fn();
const resolveActorRole = vi.fn();
let REQUESTOR: { role: string; email: string; sms_from_number: string | null } | null;
/** Application records the stub "stores", keyed the way the route filters them. */
let APP_ROWS: StoredRecord[];
let APP_QUERY_ERROR: { message: string } | null;
let LINKED_PROPERTY_IDS: string[];
let PROFILE_UPDATE_CALLS: number;
const linkedEditScope = vi.fn();

vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
// Admin resolution is not what these tests pin; the guard runs for every
// manager role. REQUESTOR.role === "admin" already short-circuits in the route.
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => false }));
vi.mock("@/lib/application-lifecycle-sms.server", () => ({ notifyApplicantApplicationSms: smsNotify }));
vi.mock("@/lib/auth/resident-role-access", () => ({ resolveResidentScopedActorRole: resolveActorRole }));
vi.mock("@/lib/auth/co-manager-module-scope", () => ({
  linkedPropertyIdsForModule: async () => new Set(LINKED_PROPERTY_IDS),
  linkedOwnerScopeForModule: linkedEditScope,
}));
vi.mock("@/lib/manager-applications-storage", () => ({
  normalizeApplicationAxisId: (id: string) => id.trim(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => makeServiceClient(),
}));

/**
 * Minimal chainable Supabase stub. The application-record builder HONORS its
 * filters (`.in("id", …)` vs `.eq("resident_email", …)`) so the id lookup and the
 * email fallback are genuinely distinct paths — a stub that answered with the same
 * row regardless would pass whether or not the fallback exists. The update chain is
 * awaited directly, so the builder is also thenable and records that a profile write
 * was attempted — a withdrawn approval must never reach it.
 */
function matchingRecords(filters: { ids: string[] | null; residentEmail: string | null }): StoredRecord[] {
  return APP_ROWS.filter((row) => {
    if (filters.ids) return filters.ids.includes(row.id);
    if (filters.residentEmail) return row.resident_email === filters.residentEmail;
    return false;
  });
}

function makeServiceClient() {
  return {
    from(table: string) {
      const filters: { ids: string[] | null; residentEmail: string | null } = { ids: null, residentEmail: null };
      const builder: Record<string, unknown> = {
        select() {
          return builder;
        },
        update() {
          if (table === "profiles") PROFILE_UPDATE_CALLS += 1;
          return builder;
        },
        eq(column: string, value: string) {
          if (column === "resident_email") filters.residentEmail = value;
          return builder;
        },
        in(column: string, values: string[]) {
          if (column === "id") filters.ids = values;
          return builder;
        },
        order() {
          return builder;
        },
        limit() {
          return builder;
        },
        maybeSingle() {
          if (table === "profiles") return Promise.resolve({ data: REQUESTOR, error: null });
          if (table !== "manager_application_records") return Promise.resolve({ data: null, error: null });
          if (APP_QUERY_ERROR) return Promise.resolve({ data: null, error: APP_QUERY_ERROR });
          return Promise.resolve({ data: matchingRecords(filters)[0] ?? null, error: null });
        },
        then(resolve: (v: { data?: unknown; error: unknown }) => unknown) {
          if (table === "manager_application_records") {
            if (APP_QUERY_ERROR) return Promise.resolve({ data: null, error: APP_QUERY_ERROR }).then(resolve);
            return Promise.resolve({ data: matchingRecords(filters), error: null }).then(resolve);
          }
          return Promise.resolve({ data: null, error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
}

function patch(body: unknown) {
  return new Request("http://localhost/api/portal/resident-approval", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function appRow(over: Partial<DemoApplicantRow>): DemoApplicantRow {
  return {
    id: "AXIS-9001",
    name: "Withdrawn Applicant",
    property: "The Pioneer",
    stage: "Submitted",
    bucket: "pending",
    detail: "",
    email: "applicant@example.com",
    ...over,
  };
}

const WITHDRAWN_ROW: StoredRecord = {
  id: "AXIS-9001",
  row_data: appRow({ withdrawnAt: "2026-07-22T00:00:00.000Z" }),
  resident_email: "applicant@example.com",
  manager_user_id: "mgr-1",
  property_id: "mgr-demo-pioneer",
};

describe("PATCH /api/portal/resident-approval — withdrawn applications are not approvable", () => {
  beforeEach(() => {
    getUser.mockReset();
    getUser.mockResolvedValue({ data: { user: { id: "mgr-1" } } });
    REQUESTOR = { role: "manager", email: "mgr@example.com", sms_from_number: null };
    APP_ROWS = [
      {
        id: "AXIS-9001",
        row_data: appRow({}),
        resident_email: "applicant@example.com",
        manager_user_id: "mgr-1",
        property_id: "mgr-demo-pioneer",
      },
    ];
    APP_QUERY_ERROR = null;
    LINKED_PROPERTY_IDS = [];
    PROFILE_UPDATE_CALLS = 0;
    smsNotify.mockReset();
    smsNotify.mockResolvedValue({ sent: false, accepted: true, error: "queued", outboxStatus: "queued" });
    resolveActorRole.mockImplementation(async (_db: unknown, args: { legacyRole: string }) => args.legacyRole);
    linkedEditScope.mockResolvedValue({ ownerIds: new Set(), propertyIds: new Set() });
  });

  it("rejects approving a withdrawn application (409) and never writes application_approved", async () => {
    APP_ROWS = [WITHDRAWN_ROW];
    const { PATCH } = await import("@/app/api/portal/resident-approval/route");
    const res = await PATCH(
      patch({ email: "applicant@example.com", approved: true, applicationId: "AXIS-9001" }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/withdrawn/i);
    // The refusal names the matched record so the client can tell an id match (this
    // application) from an email-fallback match (possibly a sibling application).
    expect(body.blockedApplicationId).toBe("AXIS-9001");
    expect(body.matchedBy).toBe("id");
    // The provisioning write must not have happened.
    expect(PROFILE_UPDATE_CALLS).toBe(0);
  });

  it("rejects even when the client omits applicationId (falls back to the latest record by email)", async () => {
    APP_ROWS = [WITHDRAWN_ROW];
    const { PATCH } = await import("@/app/api/portal/resident-approval/route");
    const res = await PATCH(patch({ email: "applicant@example.com", approved: true }));
    expect(res.status).toBe(409);
    expect(PROFILE_UPDATE_CALLS).toBe(0);
  });

  it("rejects when the client sends a bogus applicationId — the email fallback still finds the withdrawal", async () => {
    APP_ROWS = [WITHDRAWN_ROW];
    const { PATCH } = await import("@/app/api/portal/resident-approval/route");
    const res = await PATCH(
      patch({ email: "applicant@example.com", approved: true, applicationId: "not-a-real-id" }),
    );
    expect(res.status).toBe(409);
    expect(PROFILE_UPDATE_CALLS).toBe(0);
  });

  it("does NOT let the email fallback cross landlords — another manager's withdrawal cannot block this approval", async () => {
    // Same applicant, different landlord's record. Blocking here would permanently
    // and invisibly reject this manager's legitimate approval.
    APP_ROWS = [
      {
        id: "AXIS-OTHER",
        row_data: appRow({ id: "AXIS-OTHER", withdrawnAt: "2026-07-22T00:00:00.000Z" }),
        resident_email: "applicant@example.com",
        manager_user_id: "other-landlord",
        property_id: "other-landlord-prop",
      },
    ];
    const { PATCH } = await import("@/app/api/portal/resident-approval/route");
    const res = await PATCH(
      patch({ email: "applicant@example.com", approved: true, applicationId: "unknown-id" }),
    );
    expect(res.status).toBe(200);
    expect(PROFILE_UPDATE_CALLS).toBe(1);
  });

  it("still blocks via the email fallback on a CO-MANAGED record the caller does not own", async () => {
    APP_ROWS = [
      {
        id: "AXIS-LINKED",
        row_data: appRow({ id: "AXIS-LINKED", withdrawnAt: "2026-07-22T00:00:00.000Z" }),
        resident_email: "applicant@example.com",
        manager_user_id: "linked-owner",
        property_id: "linked-prop",
      },
    ];
    LINKED_PROPERTY_IDS = ["linked-prop"];
    const { PATCH } = await import("@/app/api/portal/resident-approval/route");
    const res = await PATCH(
      patch({ email: "applicant@example.com", approved: true, applicationId: "unknown-id" }),
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    // Matched by email, so the id it names is NOT necessarily the approved one.
    expect(body.matchedBy).toBe("email");
    expect(body.blockedApplicationId).toBe("AXIS-LINKED");
    expect(PROFILE_UPDATE_CALLS).toBe(0);
  });

  it("fails CLOSED on a lookup error instead of letting the approval through", async () => {
    APP_QUERY_ERROR = { message: "connection reset" };
    const { PATCH } = await import("@/app/api/portal/resident-approval/route");
    const res = await PATCH(
      patch({ email: "applicant@example.com", approved: true, applicationId: "AXIS-9001" }),
    );
    expect(res.status).toBe(500);
    expect(PROFILE_UPDATE_CALLS).toBe(0);
  });

  it("fires for a co-manager/admin approving a row owned by another manager", async () => {
    // The record keeps the linked OWNER's manager_user_id; scoping the lookup to the
    // acting user would have made the guard silently never fire for these callers.
    getUser.mockResolvedValue({ data: { user: { id: "co-manager-2" } } });
    REQUESTOR = { role: "admin", email: "admin@example.com", sms_from_number: null };
    APP_ROWS = [WITHDRAWN_ROW];
    const { PATCH } = await import("@/app/api/portal/resident-approval/route");
    const res = await PATCH(
      patch({ email: "applicant@example.com", approved: true, applicationId: "AXIS-9001" }),
    );
    expect(res.status).toBe(409);
    expect(PROFILE_UPDATE_CALLS).toBe(0);
  });

  it("still approves a normal (non-withdrawn) application — the guard does not over-block", async () => {
    APP_ROWS = [{ id: "AXIS-9001", row_data: appRow({ withdrawnAt: null }), resident_email: "applicant@example.com" }];
    const { PATCH } = await import("@/app/api/portal/resident-approval/route");
    const res = await PATCH(
      patch({ email: "applicant@example.com", approved: true, applicationId: "AXIS-9001" }),
    );
    expect(res.status).toBe(200);
    expect((await res.json()).ok).toBe(true);
    expect(PROFILE_UPDATE_CALLS).toBe(1);
  });

  it("uses only the exact approved stored row for selected SMS and reports a queued delivery honestly", async () => {
    APP_ROWS = [{
      id: "AXIS-9001",
      row_data: appRow({ bucket: "approved", application: { phone: "+12065550142" } }),
      resident_email: "applicant@example.com",
      manager_user_id: "mgr-1",
      property_id: "mgr-demo-pioneer",
    }];
    const { PATCH } = await import("@/app/api/portal/resident-approval/route");
    const res = await PATCH(patch({ email: "applicant@example.com", approved: true, applicationId: "AXIS-9001", notifySms: true, notifyEmail: false }));
    expect(res.status).toBe(200);
    expect(smsNotify).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      applicantEmail: "applicant@example.com", applicantPhone: "+12065550142", managerUserId: "mgr-1",
      setupEmailSelected: false,
    }));
    expect(await res.json()).toMatchObject({ ok: true, sms: { sms: "queued" } });
  });

  it("does not invoke SMS when the selected channel is false", async () => {
    APP_ROWS = [{ id: "AXIS-9001", row_data: appRow({ bucket: "approved" }), resident_email: "applicant@example.com", manager_user_id: "mgr-1" }];
    const { PATCH } = await import("@/app/api/portal/resident-approval/route");
    const res = await PATCH(patch({ email: "applicant@example.com", approved: true, applicationId: "AXIS-9001", notifySms: false }));
    expect(res.status).toBe(200);
    expect(smsNotify).not.toHaveBeenCalled();
  });

  it("refuses a foreign co-manager application without a current edit grant", async () => {
    getUser.mockResolvedValue({ data: { user: { id: "co-manager" } } });
    APP_ROWS = [{ id: "AXIS-9001", row_data: appRow({ bucket: "approved", application: { phone: "+12065550142" } }), resident_email: "applicant@example.com", manager_user_id: "owner-1", property_id: "property-1" }];
    linkedEditScope.mockResolvedValue({ ownerIds: new Set(["owner-1"]), propertyIds: new Set(["other-property"]) });
    const { PATCH } = await import("@/app/api/portal/resident-approval/route");
    const res = await PATCH(patch({ email: "applicant@example.com", approved: true, applicationId: "AXIS-9001", notifySms: true }));
    expect(res.status).toBe(403);
    expect(smsNotify).not.toHaveBeenCalled();
    expect(PROFILE_UPDATE_CALLS).toBe(0);
  });

  it("keeps a committed approval successful when the selected SMS throws late", async () => {
    APP_ROWS = [{ id: "AXIS-9001", row_data: appRow({ bucket: "approved", application: { phone: "+12065550142" } }), resident_email: "applicant@example.com", manager_user_id: "mgr-1" }];
    smsNotify.mockRejectedValueOnce(new Error("provider unavailable"));
    const { PATCH } = await import("@/app/api/portal/resident-approval/route");
    const res = await PATCH(patch({ email: "applicant@example.com", approved: true, applicationId: "AXIS-9001", notifySms: true }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, sms: { sms: "failed" } });
    expect(PROFILE_UPDATE_CALLS).toBe(1);
  });

  it("with no application record at all the withdrawn guard stays silent — the ownership check refuses instead", async () => {
    // The guard cannot block what does not exist, so it passes through. The
    // approval still fails closed: setResidentApprovalForManager refuses a
    // resident the caller has no application/charge/lease relationship to, and
    // nothing is written.
    APP_ROWS = [];
    const { PATCH } = await import("@/app/api/portal/resident-approval/route");
    const res = await PATCH(
      patch({ email: "applicant@example.com", approved: true, applicationId: "AXIS-9001" }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/portfolio/i);
    expect(PROFILE_UPDATE_CALLS).toBe(0);
  });
});
