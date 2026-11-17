import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const proven = vi.fn();
vi.mock("@/lib/prospect-spine/link.server", () => ({ phoneProvenFor: (...a: unknown[]) => proven(...a) }));
vi.mock("@/lib/resident-identity/baseline.server", () => ({ resolveBaselineResidentIdentity: async () => "ok" }));
vi.mock("@/lib/screening/preapply.server", () => ({
  preApplySubmitGate: async (_db: unknown, _user: unknown, row: unknown) => ({ ok: true, row }),
}));
vi.mock("@/lib/rental-application/validate-application-submit.server", () => ({
  validateResidentApplicationRowForPersistence: async () => ({ ok: true }),
}));
vi.mock("@/lib/rental-application/application-fee-submit-guard.server", () => ({
  authorizeApplicationFeeSubmission: async () => ({ ok: true }),
  reuseApplicationFeeAuthorization: () => null,
}));
vi.mock("@/lib/auth/link-resident-on-application-submit", () => ({
  linkResidentOnApplicationSubmit: async (_db: unknown, p: { row: Record<string, unknown>; userId: string }) => ({
    ok: true,
    row: { ...p.row, residentUserId: p.userId },
  }),
}));
vi.mock("@/lib/rental-application/standard-stay-times.server", () => ({
  standardizeApplicantStayTimes: async (_db: unknown, row: unknown) => row,
}));
vi.mock("@/lib/rental-application/applicant-identity.server", () => ({
  fillApplicantIdentityFromAccount: async (_db: unknown, _u: unknown, row: unknown) => row,
}));

import { prepareResidentSelfWrite } from "@/lib/rental-application/signed-in-application-write.server";
import { resolveApplicantIdentity } from "@/lib/rental-application/applicant-identity";

const PHONE_USER = { id: "user-phone", email: "86a2e10a@phone.proplane.invalid", email_confirmed_at: "2026-11-17T03:50:52Z" };

/** No stored application (a NEW one), and the profile read the phone-proof check makes. */
function fakeDb(profile: Record<string, unknown> | null) {
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "in", "limit"]) chain[m] = () => chain;
      chain.maybeSingle = async () => ({ data: table === "profiles" ? profile : null, error: null });
      chain.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res);
      return chain;
    },
  } as never;
}

const row = {
  id: "PROPLANE-NEWROW01",
  bucket: "pending",
  stage: "Submitted",
  email: "applicant@uw.edu",
  name: "Cori Applicant",
  propertyId: "prop-1",
  application: { propertyId: "prop-1", email: "applicant@uw.edu", fullLegalName: "Cori Applicant" },
} as never;

beforeEach(() => proven.mockReset());

describe("an account that signed up by a texted code can send its own application", () => {
  it("a proven phone with no mailbox may submit a NEW application with the email it typed, bound to its own login", async () => {
    proven.mockResolvedValue(true);
    const db = fakeDb({ phone: "+13135550100", phone_verified_at: "2026-11-17T03:50:53Z" });
    const out = await prepareResidentSelfWrite(db, PHONE_USER, { row, requestedRowId: "PROPLANE-NEWROW01", role: "resident", email: "" });
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.row.residentUserId).toBe("user-phone");
      expect(out.row.email).toBe("applicant@uw.edu");
    }
    expect(proven).toHaveBeenCalledWith(db, "user-phone", "+13135550100");
  });

  it("no proven phone and no mailbox is still refused", async () => {
    proven.mockResolvedValue(false);
    for (const profile of [null, { phone: "+13135550100", phone_verified_at: null }, { phone: "+13135550100", phone_verified_at: "x" }]) {
      const out = await prepareResidentSelfWrite(fakeDb(profile), PHONE_USER, { row, requestedRowId: "PROPLANE-NEWROW01", role: "resident", email: "" });
      expect(out.ok).toBe(false);
      if (!out.ok) expect(out.body.error).toBe("You can only update your own application.");
    }
  });

  it("an account WITH a verified mailbox still has to apply under that mailbox", async () => {
    proven.mockResolvedValue(true);
    const out = await prepareResidentSelfWrite(
      fakeDb({ phone: "+13135550100", phone_verified_at: "2026-11-17T03:50:53Z" }),
      { id: "user-mail", email: "someone@else.com", email_confirmed_at: "2026-01-01" },
      { row, requestedRowId: "PROPLANE-NEWROW01", role: "resident", email: "someone@else.com" },
    );
    expect(out.ok).toBe(false);
    expect(proven).not.toHaveBeenCalled();
  });

  it("a phone account's placeholder address is never taken as the applicant's email", () => {
    const identity = resolveApplicantIdentity({
      answers: { email: "applicant@uw.edu" },
      authUser: { email: "86a2e10a@phone.proplane.invalid" },
      profile: { email: "86a2e10a@phone.proplane.invalid" },
    });
    expect(identity.email).toBe("applicant@uw.edu");
    expect(identity.emailMismatch).toBe(false);
  });
});
