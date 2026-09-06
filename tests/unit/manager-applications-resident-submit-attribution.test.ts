import { randomBytes } from "node:crypto";
/**
 * Route-level regression for the reported bug and its authorization half:
 * `POST /api/manager-applications` as a signed-in RESIDENT.
 *
 * `managerUserId` is the only thing that decides whose Applications tab a row
 * lands in, so it is derived from the LISTING (or the already-stored value on an
 * edit) and never from the request body. This drives the real route handler
 * end-to-end and asserts on the row actually persisted.
 *
 * Set RESIDENT_SUBMIT_TRANSCRIPT to dump the request/response transcript.
 */
import { afterEach, beforeEach, afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { createDefaultListingSubmission } from "@/lib/manager-listing-submission";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";
import type { RentalWizardFormState } from "@/lib/rental-application/types";

const TRANSCRIPT_PATH = process.env.RESIDENT_SUBMIT_TRANSCRIPT;
const transcript: string[] = [];
function note(line: string) {
  transcript.push(line);
}

const getUser = vi.fn();
let PROFILE: { role: string; email: string } | null = null;
/** `manager_property_records` keyed by listing id — the server's attribution source. */
let PROPERTY_RECORDS: Record<string, { manager_user_id: string | null; status?: string | null; property_data: unknown }> = {};
let STORED_ROWS: { id: string; row_data: DemoApplicantRow }[] = [];
let UPSERTS: { id: string; manager_user_id: string | null; row_data: DemoApplicantRow }[] = [];

vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: vi.fn(async () => false) }));
vi.mock("@/lib/auth/provision-approved-resident", () => ({
  provisionApprovedResidentAccount: vi.fn(async () => ({ ok: true })),
}));
vi.mock("@/lib/screening/order-screening", () => ({ tryAutoOrderScreening: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => makeDb() }));

/** Chainable Supabase stub: enough of the surface the route touches to be real. */
function makeDb() {
  return {
    from(table: string) {
      const state: { ids: string[] | null; eqId: string | null } = { ids: null, eqId: null };
      const builder: Record<string, unknown> = {
        select: () => builder,
        update: () => builder,
        insert: () => Promise.resolve({ error: null }),
        upsert(values: { id: string; manager_user_id: string | null; row_data: DemoApplicantRow }) {
          if (table === "manager_application_records") UPSERTS.push(values);
          return Promise.resolve({ error: null });
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
const VICTIM = "mgr-someone-elses-portfolio";
const LISTING = "mgr-magnolia-2b-a1b2c3";

function validSubmittedApplication(
  over: Partial<RentalWizardFormState> = {},
): RentalWizardFormState {
  return {
    ...createInitialRentalWizardState(),
    applyingAsGroup: "no",
    hasCosigner: "no",
    propertyId: LISTING,
    roomChoice1: LISTING,
    leaseTerm: "12-Month",
    leaseStart: "2027-08-01",
    leaseEnd: "2028-07-31",
    fullLegalName: "Maya Alvarez",
    dateOfBirth: "1995-01-15",
    ssn: "123-45-6789",
    driversLicense: "WA1234567",
    phone: "(206) 555-0100",
    email: "maya.alvarez@example.com",
    currentStreet: "100 Main St",
    currentCity: "Seattle",
    currentState: "WA",
    currentZip: "98101",
    noPreviousAddress: true,
    notEmployed: false,
    employer: "PropLane",
    monthlyIncome: "5,000",
    ref1Name: "Sam Rivera",
    ref1Relationship: "Friend",
    ref1Phone: "(206) 555-0101",
    occupancyCount: "1",
    evictionHistory: "no",
    bankruptcyHistory: "no",
    criminalHistory: "no",
    consentCredit: true,
    consentTruth: true,
    digitalSignature: "Maya Alvarez",
    dateSigned: "2026-09-04",
    ...over,
  };
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
    application: validSubmittedApplication(),
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
  vi.stubEnv("DATA_ENCRYPTION_ACTIVE_KEY_ID", "test");
  vi.stubEnv("DATA_ENCRYPTION_KEYS_JSON", JSON.stringify({ test: randomBytes(32).toString("base64") }));
  vi.clearAllMocks();
  PROFILE = { role: "resident", email: "maya.alvarez@example.com" };
  getUser.mockResolvedValue({
    data: { user: { id: "resident-user-1", email: "maya.alvarez@example.com", user_metadata: {} } },
    error: null,
  });
  PROPERTY_RECORDS = {
    [LISTING]: {
      manager_user_id: OWNER,
      status: "live",
      property_data: {
        id: LISTING,
        listingSubmission: createDefaultListingSubmission(),
      },
    },
  };
  STORED_ROWS = [];
  UPSERTS = [];
});

afterAll(() => {
  if (!TRANSCRIPT_PATH) return;
  fs.mkdirSync(path.dirname(TRANSCRIPT_PATH), { recursive: true });
  fs.writeFileSync(TRANSCRIPT_PATH, transcript.join("\n") + "\n", "utf8");
});

describe("POST /api/manager-applications — resident submit attribution", () => {
  it("rejects a submitted row with a valid id but no application answers", async () => {
    const res = await submit(residentRow({ application: undefined }));

    expect(res.status).toBe(422);
    expect(res.body.fieldErrors).toMatchObject({
      _general: "Application answers are required before submission.",
    });
    expect(UPSERTS).toHaveLength(0);
  });

  it("rejects an unanswered required custom question on the Review step", async () => {
    PROPERTY_RECORDS[LISTING] = {
      manager_user_id: OWNER,
      property_data: {
        id: LISTING,
        listingSubmission: {
          ...createDefaultListingSubmission(),
          applicationConfigMode: "custom",
          customApplicationFields: [
            {
              id: "caf-review",
              key: "review-confirmation",
              label: "Confirm the information above",
              type: "checkbox",
              required: true,
              options: [],
              section: "review",
            },
          ],
        },
      },
    };

    const res = await submit(residentRow());

    expect(res.status).toBe(422);
    expect(res.body.step).toBe(10);
    expect(res.body.fieldErrors).toMatchObject({
      "custom:review-confirmation": "This box must be checked to continue.",
    });
    expect(UPSERTS).toHaveLength(0);
  });

  it("attributes a resident's submit to the listing's manager", async () => {
    const res = await submit(residentRow());

    note("# 1. Resident submits an application to The Magnolia · 2B (owned by " + OWNER + ")");
    note("POST /api/manager-applications  (session: resident maya.alvarez@example.com)");
    note("  request.row.managerUserId  = <absent>");
    note(`  -> ${res.status} ${JSON.stringify(res.body)}`);
    note(`  persisted manager_user_id  = ${UPSERTS[0]?.manager_user_id}   <- resolved from the listing record`);
    note("");

    expect(res.status).toBe(200);
    expect(UPSERTS).toHaveLength(1);
    expect(UPSERTS[0].manager_user_id).toBe(OWNER);
    expect(UPSERTS[0].row_data.managerUserId).toBe(OWNER);
  });

  it("ignores a forged managerUserId in the request body", async () => {
    const res = await submit(residentRow({ managerUserId: VICTIM }));

    note("# 2. Same submit, but the body forges managerUserId to another manager");
    note("POST /api/manager-applications  (session: resident maya.alvarez@example.com)");
    note(`  request.row.managerUserId  = ${VICTIM}   <- attacker-supplied`);
    note(`  -> ${res.status} ${JSON.stringify(res.body)}`);
    note(`  persisted manager_user_id  = ${UPSERTS[0]?.manager_user_id}   <- listing wins; no row in ${VICTIM}'s portal`);
    note("");

    expect(res.status).toBe(200);
    expect(UPSERTS[0].manager_user_id).toBe(OWNER);
    expect(UPSERTS[0].row_data.managerUserId).toBe(OWNER);
  });

  it("refuses a new submit for a listing that resolves to no manager", async () => {
    PROPERTY_RECORDS = {};
    const res = await submit(residentRow({ propertyId: "prop-unknown", managerUserId: VICTIM }));

    note("# 3. Submit for a listing with no manager, forging managerUserId");
    note("POST /api/manager-applications  (session: resident maya.alvarez@example.com)");
    note(`  request.row.propertyId     = prop-unknown`);
    note(`  request.row.managerUserId  = ${VICTIM}   <- attacker-supplied`);
    note(`  -> ${res.status} ${JSON.stringify(res.body)}`);
    note(`  rows persisted             = ${UPSERTS.length}   <- refused, so no unattributed orphan row`);
    note("");

    expect(res.status).toBe(400);
    expect(UPSERTS).toHaveLength(0);
  });

  it("keeps the stored attribution when the resident edits a pending application", async () => {
    PROPERTY_RECORDS = {};
    STORED_ROWS = [{ id: "AXIS-90210", row_data: residentRow({ managerUserId: OWNER }) }];
    const res = await submit(residentRow({ managerUserId: VICTIM, detail: "edited" }));

    note("# 4. Resident edits the pending application, forging managerUserId");
    note("POST /api/manager-applications  (session: resident maya.alvarez@example.com)");
    note(`  stored manager_user_id     = ${OWNER}`);
    note(`  request.row.managerUserId  = ${VICTIM}   <- attacker-supplied`);
    note(`  -> ${res.status} ${JSON.stringify(res.body)}`);
    note(`  persisted manager_user_id  = ${UPSERTS[0]?.manager_user_id}   <- stored attribution re-anchored`);

    expect(res.status).toBe(200);
    expect(UPSERTS[0].manager_user_id).toBe(OWNER);
  });
});

afterEach(() => vi.unstubAllEnvs());
