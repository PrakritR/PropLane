import { describe, expect, it } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import {
  attachResidentSetupToken,
  findApplicationForResidentSetup,
  buildResidentSetupHref,
  residentSetupIdFromUrlParams,
  hashResidentSetupToken,
  isResidentSetupTokenValid,
  markResidentSetupTokenConsumed,
  residentSetupAccountUrl,
} from "@/lib/auth/resident-setup-token";

function baseRow(overrides: Partial<DemoApplicantRow> = {}): DemoApplicantRow {
  return {
    id: "AXIS-ABC12345",
    name: "Alex Chen",
    property: "Sunset House",
    stage: "Submitted",
    bucket: "pending",
    detail: "Submitted",
    email: "alex@example.com",
    ...overrides,
  };
}

describe("resident-setup-token", () => {
  it("hashes tokens and validates matching raw tokens", () => {
    const now = new Date();
    const { row, token } = attachResidentSetupToken(baseRow(), {
      now,
      ttlMs: 60_000,
    });
    expect(row.setupTokenHash).toBe(hashResidentSetupToken(token));
    expect(row.setupTokenExpiresAt).toBe(new Date(now.getTime() + 60_000).toISOString());
    expect(row.setupTokenConsumedAt).toBeNull();
    expect(isResidentSetupTokenValid(row, token)).toBe(true);
    expect(isResidentSetupTokenValid(row, "wrong-token")).toBe(false);
  });

  it("rejects expired and consumed tokens", () => {
    const { row, token } = attachResidentSetupToken(baseRow(), {
      now: new Date(),
      ttlMs: 60_000,
    });
    expect(isResidentSetupTokenValid({ ...row, setupTokenExpiresAt: "2020-01-01T00:00:00.000Z" }, token)).toBe(false);
    expect(isResidentSetupTokenValid(markResidentSetupTokenConsumed(row), token)).toBe(false);
  });

  it("permits consumed-token retry only for the original subject and before expiry", async () => {
    const issued = attachResidentSetupToken(baseRow(), { ttlMs: 60_000 });
    const row = { ...markResidentSetupTokenConsumed(issued.row), residentUserId: "owner" };
    const database = (candidate: DemoApplicantRow) => ({ from: () => ({ select: () => ({ in: () => ({ limit: async () => ({ data: [{ id: candidate.id, resident_email: candidate.email, row_data: candidate }], error: null }) }) }) }) });
    expect((await findApplicationForResidentSetup(database(row) as never, { token: issued.token, axisId: row.id, consumedByUserId: "owner" })).ok).toBe(true);
    expect((await findApplicationForResidentSetup(database(row) as never, { token: issued.token, axisId: row.id, consumedByUserId: "other" })).ok).toBe(false);
    expect((await findApplicationForResidentSetup(database(row) as never, { token: "wrong", axisId: row.id, consumedByUserId: "owner" })).ok).toBe(false);
    expect((await findApplicationForResidentSetup(database({ ...row, setupTokenExpiresAt: "2020-01-01" }) as never, { token: issued.token, axisId: row.id, consumedByUserId: "owner" })).ok).toBe(false);
  });

  it("builds setup href and absolute URL", () => {
    expect(buildResidentSetupHref("tok_abc", "AXIS-1")).toBe(
      "/auth/resident-setup?token=tok_abc&proplane_id=PROPLANE-1",
    );
    expect(residentSetupAccountUrl("https://prop-lane.space", "tok_abc", "AXIS-1")).toBe(
      "https://prop-lane.space/auth/resident-setup?token=tok_abc&proplane_id=PROPLANE-1",
    );
  });

  it("reads proplane_id from URL params with legacy axis_id fallback", () => {
    const params = new URLSearchParams("proplane_id=AXIS-NEW&axis_id=AXIS-OLD");
    expect(residentSetupIdFromUrlParams(params)).toBe("AXIS-NEW");

    const legacy = new URLSearchParams("axis_id=AXIS-LEGACY");
    expect(residentSetupIdFromUrlParams(legacy)).toBe("AXIS-LEGACY");

    expect(residentSetupIdFromUrlParams(new URLSearchParams())).toBe("");
  });
});
