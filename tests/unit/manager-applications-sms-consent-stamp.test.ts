/**
 * Route-level regression: SMS consent evidence on the application snapshot is
 * SERVER-owned. `POST /api/manager-applications` (upsert) must never trust the
 * client-supplied `smsConsentAt` / `smsConsentWordingVersion` — it stamps a
 * server timestamp + the current wording version when `smsConsent` is true,
 * preserves the FIRST server stamp across the draft flow's re-upserts, and
 * clears both when consent is off.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { RentalWizardFormState } from "@/lib/rental-application/types";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";
import { SMS_CONSENT_WORDING_VERSION } from "@/lib/rental-application/sms-consent";

const getUser = vi.fn();
let PROFILE: { role: string; email: string } | null = null;
let PROPERTY_RECORDS: Record<string, { manager_user_id: string | null; status?: string | null; property_data: unknown }> = {};
let STORED_ROWS: { id: string; row_data: DemoApplicantRow }[] = [];
let UPSERTS: { id: string; manager_user_id: string | null; row_data: DemoApplicantRow }[] = [];
let UPSERT_ERROR: { message: string; code?: string } | null = null;
let APPLICATION_LOAD_FAILURE_AT: number | null = null;
let applicationLoadCount = 0;
const revokeApplicationConsent = vi.fn(async () => ({ ok: true as const }));

vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: vi.fn(async () => false) }));
vi.mock("@/lib/auth/provision-approved-resident", () => ({
  provisionApprovedResidentAccount: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/screening/order-screening", () => ({ tryAutoOrderScreening: vi.fn() }));
vi.mock("@/lib/sms/application-consent.server", () => ({
  revokeApplicationScopedSmsConsentOnWithdrawal: revokeApplicationConsent,
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => makeDb() }));

function makeDb() {
  return {
    from(table: string) {
      const state: { ids: string[] | null; eqId: string | null } = { ids: null, eqId: null };
      let selected = false;
      const builder: Record<string, unknown> = {
        select: () => {
          selected = true;
          return builder;
        },
        update: () => builder,
        insert: () => Promise.resolve({ error: null }),
        upsert(values: { id: string; manager_user_id: string | null; row_data: DemoApplicantRow }) {
          if (table === "manager_application_records") UPSERTS.push(values);
          return Promise.resolve({ error: table === "manager_application_records" ? UPSERT_ERROR : null });
        },
        delete: () => builder,
        eq(column: string, value: string) {
          if (column === "id") state.eqId = value;
          return builder;
        },
        ilike: () => builder,
        in(column: string, values: string[]) {
          if (column === "id") state.ids = values;
          return builder;
        },
        order: () => builder,
        limit: () => builder,
        maybeSingle() {
          if (table === "profiles") return Promise.resolve({ data: PROFILE, error: null });
          if (table === "manager_property_records") {
            return Promise.resolve({ data: (state.eqId && PROPERTY_RECORDS[state.eqId]) || null, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
          if (table === "manager_application_records") {
            if (selected) applicationLoadCount += 1;
            if (
              selected &&
              APPLICATION_LOAD_FAILURE_AT === applicationLoadCount
            ) {
              return Promise.resolve({
                data: null,
                error: { message: "database unavailable" },
              }).then(resolve);
            }
            const rows = state.ids ? STORED_ROWS.filter((r) => state.ids?.includes(r.id)) : STORED_ROWS;
            return Promise.resolve({ data: rows, error: null }).then(resolve);
          }
          return Promise.resolve({ data: null, error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
}

const OWNER = "mgr-owner-of-the-magnolia";
const LISTING = "mgr-magnolia-2b-a1b2c3";
const FORGED_AT = "1999-01-01T00:00:00.000Z";

function application(over: Partial<RentalWizardFormState> = {}): RentalWizardFormState {
  return { ...createInitialRentalWizardState(), propertyId: LISTING, ...over };
}

function residentRow(over: Partial<DemoApplicantRow> = {}): DemoApplicantRow {
  return {
    id: "AXIS-90210",
    name: "Maya Alvarez",
    email: "maya.alvarez@example.com",
    property: "The Magnolia · 2B",
    propertyId: LISTING,
    stage: "Submitted",
    bucket: "pending",
    detail: "",
    ...over,
  };
}

async function submit(row: DemoApplicantRow) {
  const { POST } = await import("@/app/api/manager-applications/route");
  const res = await POST(
    new Request("http://localhost/api/manager-applications", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ row }),
    }),
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(() => {
  vi.clearAllMocks();
  PROFILE = { role: "resident", email: "maya.alvarez@example.com" };
  getUser.mockResolvedValue({
    data: { user: { id: "resident-user-1", email: "maya.alvarez@example.com", user_metadata: {} } },
    error: null,
  });
  PROPERTY_RECORDS = { [LISTING]: { manager_user_id: OWNER, status: "live", property_data: {} } };
  STORED_ROWS = [];
  UPSERTS = [];
  UPSERT_ERROR = null;
  APPLICATION_LOAD_FAILURE_AT = null;
  applicationLoadCount = 0;
});

describe("POST /api/manager-applications — server-owned SMS consent stamp", () => {
  it("stamps a server timestamp + wording version, ignoring the client-supplied smsConsentAt", async () => {
    const before = Date.now();
    const res = await submit(
      residentRow({
        application: application({
          smsConsent: true,
          smsConsentAt: FORGED_AT,
          smsConsentWordingVersion: "forged-version",
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(UPSERTS).toHaveLength(1);
    const app = UPSERTS[0].row_data.application!;
    expect(app.smsConsent).toBe(true);
    expect(app.smsConsentAt).not.toBe(FORGED_AT);
    expect(Date.parse(app.smsConsentAt!)).toBeGreaterThanOrEqual(before);
    expect(app.smsConsentWordingVersion).toBe(SMS_CONSENT_WORDING_VERSION);
  });

  it("preserves the first server stamp (and its wording version) across re-upserts", async () => {
    const firstStamp = "2026-07-01T12:00:00.000Z";
    STORED_ROWS = [
      {
        id: "AXIS-90210",
        row_data: residentRow({
          managerUserId: OWNER,
          application: application({
            smsConsent: true,
            smsConsentAt: firstStamp,
            smsConsentWordingVersion: "2026-01-01.1",
          }),
        }),
      },
    ];

    const res = await submit(
      residentRow({
        application: application({ smsConsent: true, smsConsentAt: FORGED_AT }),
      }),
    );

    expect(res.status).toBe(200);
    const app = UPSERTS[0].row_data.application!;
    expect(app.smsConsentAt).toBe(firstStamp);
    expect(app.smsConsentWordingVersion).toBe("2026-01-01.1");
  });

  it("preserves stored consent evidence when the blob omits smsConsent entirely", async () => {
    const firstStamp = "2026-07-01T12:00:00.000Z";
    STORED_ROWS = [
      {
        id: "AXIS-90210",
        row_data: residentRow({
          managerUserId: OWNER,
          application: application({
            smsConsent: true,
            smsConsentAt: firstStamp,
            smsConsentWordingVersion: "2026-01-01.1",
          }),
        }),
      },
    ];

    const res = await submit(
      residentRow({
        application: application({
          smsConsent: undefined,
          smsConsentAt: undefined,
          smsConsentWordingVersion: undefined,
        }),
      }),
    );

    expect(res.status).toBe(200);
    const app = UPSERTS[0].row_data.application!;
    expect(app.smsConsent).toBe(true);
    expect(app.smsConsentAt).toBe(firstStamp);
    expect(app.smsConsentWordingVersion).toBe("2026-01-01.1");
  });

  it("clears the stamp and wording version when consent is off", async () => {
    STORED_ROWS = [
      {
        id: "AXIS-90210",
        row_data: residentRow({
          managerUserId: OWNER,
          application: application({
            smsConsent: true,
            smsConsentAt: "2026-07-01T12:00:00.000Z",
            smsConsentWordingVersion: SMS_CONSENT_WORDING_VERSION,
          }),
        }),
      },
    ];

    const res = await submit(
      residentRow({
        application: application({
          smsConsent: false,
          smsConsentAt: FORGED_AT,
          smsConsentWordingVersion: "forged-version",
        }),
      }),
    );

    expect(res.status).toBe(200);
    const app = UPSERTS[0].row_data.application!;
    expect(app.smsConsent).toBe(false);
    expect(app.smsConsentAt).toBeUndefined();
    expect(app.smsConsentWordingVersion).toBeUndefined();
  });

  it("fails closed instead of acknowledging an opt-out when persistence fails", async () => {
    STORED_ROWS = [
      {
        id: "AXIS-90210",
        row_data: residentRow({
          managerUserId: OWNER,
          application: application({
            smsConsent: true,
            smsConsentAt: "2026-07-01T12:00:00.000Z",
            smsConsentWordingVersion: SMS_CONSENT_WORDING_VERSION,
          }),
        }),
      },
    ];
    UPSERT_ERROR = { message: "database unavailable" };

    const res = await submit(
      residentRow({ application: application({ smsConsent: false }) }),
    );

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Could not persist the application");
    expect(revokeApplicationConsent).not.toHaveBeenCalled();
  });

  it("fails closed when the pre-revocation consent snapshot cannot be reloaded", async () => {
    STORED_ROWS = [
      {
        id: "AXIS-90210",
        row_data: residentRow({
          managerUserId: OWNER,
          application: application({
            smsConsent: true,
            smsConsentAt: "2026-07-01T12:00:00.000Z",
            smsConsentWordingVersion: SMS_CONSENT_WORDING_VERSION,
          }),
        }),
      },
    ];
    APPLICATION_LOAD_FAILURE_AT = 2;

    const res = await submit(
      residentRow({ application: application({ smsConsent: false }) }),
    );

    expect(res.status).toBe(500);
    expect(res.body.error).toBe("Could not load the existing application.");
    expect(UPSERTS).toHaveLength(0);
    expect(revokeApplicationConsent).not.toHaveBeenCalled();
  });
});
