import { sealApplicantRow } from "@/lib/security/applicant-identity";
import { randomBytes } from "node:crypto";
/**
 * `POST /api/portal/application-resume` — the PUBLIC apply flow's guest draft
 * resume. A true guest has no session, so after a real reload the only proof
 * they own an in-progress application is the row's freshest resident-setup
 * token. The route must return the stored row ONLY for a valid (id, token)
 * pair on a live in-progress application, strip the token credential fields
 * from the response, and answer every denial identically (no email/row oracle).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { attachResidentSetupToken } from "@/lib/auth/resident-setup-token";

let STORED_ROWS: { id: string; row_data: DemoApplicantRow }[] = [];

vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => makeDb() }));

function makeDb() {
  return {
    from(table: string) {
      const state: { ids: string[] | null } = { ids: null };
      const builder: Record<string, unknown> = {
        select: () => builder,
        in(column: string, values: string[]) {
          if (column === "id") state.ids = values;
          return builder;
        },
        limit: () => builder,
        then(resolve: (v: { data: unknown; error: unknown }) => unknown) {
          const rows =
            table === "manager_application_records"
              ? STORED_ROWS.filter((r) => state.ids?.includes(r.id))
              : [];
          return Promise.resolve({ data: rows, error: null }).then(resolve);
        },
      };
      return builder;
    },
  };
}

function baseRow(over: Partial<DemoApplicantRow> = {}): DemoApplicantRow {
  return {
    id: "PROPLANE-RESUME01",
    name: "Riley Guest",
    email: "riley.guest@example.com",
    property: "The Magnolia · 2B",
    propertyId: "mgr-magnolia-2b-a1b2c3",
    stage: "In progress",
    bucket: "pending",
    detail: "",
    application: { propertyId: "mgr-magnolia-2b-a1b2c3", wizardStep: 7 } as DemoApplicantRow["application"],
    ...over,
  };
}

/** Store a row carrying a freshly minted setup token; returns the raw token. */
function storeRowWithToken(over: Partial<DemoApplicantRow> = {}): string {
  const { row, token } = attachResidentSetupToken(baseRow(over));
  STORED_ROWS = [{ id: row.id, row_data: row }];
  return token;
}

async function resume(payload: { id?: string; token?: string }) {
  const { POST } = await import("@/app/api/portal/application-resume/route");
  const res = await POST(
    new Request("http://localhost/api/portal/application-resume", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
  return { status: res.status, body: (await res.json()) as { row?: DemoApplicantRow; error?: string } };
}

beforeEach(() => {
  vi.stubEnv("DATA_ENCRYPTION_ACTIVE_KEY_ID", "test");
  vi.stubEnv("DATA_ENCRYPTION_KEYS_JSON", JSON.stringify({ test: randomBytes(32).toString("base64") }));
  vi.clearAllMocks();
  STORED_ROWS = [];
});

describe("POST /api/portal/application-resume", () => {
  it("returns the in-progress row for a valid id + freshest setup token, with token fields stripped", async () => {
    const token = storeRowWithToken();

    const { status, body } = await resume({ id: "PROPLANE-RESUME01", token });

    expect(status).toBe(200);
    expect(body.row?.id).toBe("PROPLANE-RESUME01");
    expect(body.row?.application).toBeDefined();
    expect((body.row?.application as { wizardStep?: number } | undefined)?.wizardStep).toBe(7);
    // The token credential material never rides back to the client.
    expect(body.row).not.toHaveProperty("setupTokenHash");
    expect(body.row).not.toHaveProperty("setupTokenExpiresAt");
    expect(body.row).not.toHaveProperty("setupTokenConsumedAt");
  });

  it("answers a wrong token, a missing row, and a missing token identically (no oracle)", async () => {
    storeRowWithToken();

    const wrongToken = await resume({ id: "PROPLANE-RESUME01", token: "not-the-token" });
    const missingRow = await resume({ id: "PROPLANE-NOSUCHRW", token: "not-the-token" });
    const missingToken = await resume({ id: "PROPLANE-RESUME01" });

    for (const denial of [wrongToken, missingRow, missingToken]) {
      expect(denial.status).toBe(403);
      expect(denial.body).toEqual({ error: "Not allowed." });
    }
  });

  it("refuses a decided application even with the valid token", async () => {
    const token = storeRowWithToken({ bucket: "approved", stage: "Approved" });

    const { status, body } = await resume({ id: "PROPLANE-RESUME01", token });

    expect(status).toBe(403);
    expect(body).toEqual({ error: "Not allowed." });
  });

  it("refuses a withdrawn application even with the valid token", async () => {
    const token = storeRowWithToken({ withdrawnAt: "2026-07-01T00:00:00.000Z" });

    const { status, body } = await resume({ id: "PROPLANE-RESUME01", token });

    expect(status).toBe(403);
    expect(body).toEqual({ error: "Not allowed." });
  });
});

afterEach(() => vi.unstubAllEnvs());


it("opens protected identity only after a valid resume token and strips its metadata", async () => {
  const token = storeRowWithToken({ managerUserId: "manager-a", application: { wizardStep: 7, ssn: "123-45-6789", dateOfBirth: "1980-01-02", driversLicense: "LICENSE-TEST" } as DemoApplicantRow["application"] });
  STORED_ROWS[0].row_data = sealApplicantRow(STORED_ROWS[0].row_data, STORED_ROWS[0].id, "manager-a");
  const success = await resume({ id: "RESUME01", token });
  expect(success.status).toBe(200);
  expect(success.body.row?.application?.dateOfBirth).toBe("1980-01-02");
  expect(success.body.row).not.toHaveProperty("_applicantIdentity");
  vi.stubEnv("DATA_ENCRYPTION_KEYS_JSON", "");
  expect((await resume({ id: STORED_ROWS[0].id, token: "wrong" })).status).toBe(403);
});
