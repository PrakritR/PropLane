import { describe, expect, it, beforeEach } from "vitest";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import type { DemoApplicantRow } from "@/lib/manager-applications-storage";
// Seed the real store rather than vi.mock it: manager-applications-storage and
// lease-pipeline-storage import each other, so a mock built with importActual
// never reaches the copy lease-pipeline-storage already bound.
import {
  resolveResidentPortalAxisId,
  writeManagerApplicationRows,
} from "@/lib/manager-applications-storage";
import { residentLeaseAuthorized } from "@/lib/lease-pipeline-storage";

const seedApplications = (rows: DemoApplicantRow[]) =>
  writeManagerApplicationRows(rows, { serverConfirmed: true, skipLeaseSeed: true });

function leaseRow(overrides: Partial<LeasePipelineRow> = {}): LeasePipelineRow {
  return {
    id: "lease-1",
    residentEmail: "resident@test.proplane.local",
    residentName: "Test Resident",
    axisId: "AXIS-TEDEMOAPP4",
    managerUserId: "mgr-1",
    status: "Fully Signed",
    generatedHtml: "<p>Lease</p>",
    bucket: "resident",
    application: {},
    ...overrides,
  } as LeasePipelineRow;
}

describe("resident lease axis drift", () => {
  beforeEach(() => {
    seedApplications([]);
  });

  it("prefers the sole approved application id over a drifted profile axis id", () => {
    expect(
      resolveResidentPortalAxisId({
        profileManagerId: "AXIS-TESTRSID",
        approvedApplicationRowId: "AXIS-TEDEMOAPP4",
      }),
    ).toBe("AXIS-TEDEMOAPP4");
  });

  it("authorizes a fully signed lease when profile axis drifted but approved app matches lease axis", () => {
    seedApplications([
      {
        id: "AXIS-TEDEMOAPP4",
        email: "resident@test.proplane.local",
        bucket: "approved",
        managerUserId: "mgr-1",
      } as DemoApplicantRow,
    ]);

    const row = leaseRow();
    const ctx = {
      email: "resident@test.proplane.local",
      residentAxisId: "AXIS-TESTRSID",
      profileManagerId: "AXIS-TESTRSID",
    };

    expect(residentLeaseAuthorized(row, ctx)).toBe(true);
  });

  it("refuses the same drifted lease when no approved application matches it", () => {
    // Negative control: the authorization above comes from the approved row,
    // not from the email match alone.
    seedApplications([]);
    const ctx = {
      email: "resident@test.proplane.local",
      residentAxisId: "AXIS-TESTRSID",
      profileManagerId: "AXIS-TESTRSID",
    };
    expect(residentLeaseAuthorized(leaseRow(), ctx)).toBe(false);
  });
});
