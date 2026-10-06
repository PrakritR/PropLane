import { randomBytes } from "node:crypto";
/**
 * `promoteIncompleteApplicationAfterFeePaid` validates the stored draft before
 * promoting it. The stored `row_data` is SEALED (ssn / dateOfBirth /
 * driversLicense live in ciphertext), so validating it as read made every paid
 * guest application fail its required identity answers and stay Incomplete.
 * The draft must be opened before it is validated.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { sealApplicantRow } from "@/lib/security/applicant-identity";
import { resolveRequiredApplicationFee } from "@/lib/application-fee-checkout.server";

const prepareGuestApplicationUpsert = vi.fn();
vi.mock("@/lib/auth/guest-application-upsert", () => ({
  prepareGuestApplicationUpsert: (...args: unknown[]) => prepareGuestApplicationUpsert(...args),
}));
vi.mock("@/lib/application-submitted-notification.server", () => ({
  notifyManagerApplicationSubmitted: vi.fn(async () => undefined),
  shouldNotifyManagerOfApplicationSubmit: () => false,
}));
vi.mock("@/lib/stripe-application-fee", () => ({ isApplicationFeeCheckoutSession: () => true }));
vi.mock("@/lib/stripe-axis-ach-checkout", () => ({ axisAchCheckoutPaid: () => true }));
vi.mock("@/lib/application-fee-checkout.server", () => ({
  resolveRequiredApplicationFee: vi.fn(async () => ({ cents: 0,
    basis: { roomId: "", leaseTerm: "", bundleId: "", rentalType: "standard" } })),
  applicationFeePaymentSatisfiesTemplate: () => true,
  applicationFeeBasisFromSessionMetadata: () => ({}),
}));

const MANAGER = "11111111-1111-4111-8111-111111111111";
const ID = "PROPLANE-PROMOTE1";
let stored: { id: string; row_data: unknown; manager_user_id: string; property_id: string; assigned_property_id: null; updated_at: string }[] = [];
const upserts: unknown[] = [];

function makeDb(opts: { casRejected?: boolean; beforeCas?: () => void } = {}) {
  return {
    from() {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        // The underpay guard now re-resolves the required fee for every promote, not only when the
        // template changed, so the listing read has to answer here too.
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        limit: () => Promise.resolve({ data: stored, error: null }),
        update: (values: unknown) => {
          opts.beforeCas?.();
          upserts.push(values);
          return { eq: () => builder };
        },
      };
      builder.select = () => ({ ...builder, then: (resolve: (value: unknown) => void) => resolve({
        data: opts.casRejected ? [] : [{ id: ID }], error: null,
      }) });
      return builder;
    },
  };
}

function draft(): DemoApplicantRow {
  return {
    id: ID,
    name: "Riley Tester",
    email: "riley@example.com",
    property: "Ballard House",
    propertyId: "mgr-ballard",
    stage: "In progress",
    bucket: "pending",
    detail: "",
    managerUserId: MANAGER,
    application: {
      propertyId: "mgr-ballard",
      fullLegalName: "Riley Tester",
      email: "riley@example.com",
      ssn: "123-45-6780",
      dateOfBirth: "1997-05-20",
      driversLicense: "WDL7654321",
      hasCosigner: "no",
      applyingAsGroup: "no",
    } as DemoApplicantRow["application"],
  };
}

const session = {
  id: "cs_test_1",
  metadata: { property_id: "mgr-ballard", resident_email: "riley@example.com" },
} as unknown as Stripe.Checkout.Session;

beforeEach(() => {
  vi.stubEnv("DATA_ENCRYPTION_ACTIVE_KEY_ID", "test");
  vi.stubEnv("DATA_ENCRYPTION_KEYS_JSON", JSON.stringify({ test: randomBytes(32).toString("base64") }));
  prepareGuestApplicationUpsert.mockReset();
  prepareGuestApplicationUpsert.mockImplementation(async (_db: unknown, { row }: { row: DemoApplicantRow }) => ({ ok: true, row, setupToken: "tok" }));
  upserts.length = 0;
  stored = [
    {
      id: ID,
      row_data: sealApplicantRow(draft(), ID, MANAGER),
      manager_user_id: MANAGER,
      property_id: "mgr-ballard",
      assigned_property_id: null,
      updated_at: "2026-10-04T00:00:00Z",
    },
  ];
});

describe("promoteIncompleteApplicationAfterFeePaid", () => {
  it("validates the opened draft, with its sealed identity answers restored", async () => {
    const { promoteIncompleteApplicationAfterFeePaid } = await import("@/lib/promote-incomplete-application-after-fee.server");
    const result = await promoteIncompleteApplicationAfterFeePaid(makeDb() as never, session);

    expect(result).toMatchObject({ ok: true, promoted: true, axisId: ID });
    const validated = prepareGuestApplicationUpsert.mock.calls[0]![1].row as DemoApplicantRow & Record<string, unknown>;
    expect(validated.stage).toBe("Submitted");
    expect(validated.application).toMatchObject({ ssn: "123-45-6780", dateOfBirth: "1997-05-20", driversLicense: "WDL7654321" });
    expect(validated._applicantIdentity).toBeUndefined();
  });

  it("writes the promoted row sealed, never with plaintext identity", async () => {
    const { promoteIncompleteApplicationAfterFeePaid } = await import("@/lib/promote-incomplete-application-after-fee.server");
    await promoteIncompleteApplicationAfterFeePaid(makeDb() as never, session);

    const written = (upserts[0] as { row_data: DemoApplicantRow & Record<string, unknown> }).row_data;
    expect(written.application).not.toHaveProperty("ssn");
    expect(written._applicantIdentity).toBeDefined();
  });

  it("keeps captured money separate from promotion when pricing cannot be read", async () => {
    vi.mocked(resolveRequiredApplicationFee).mockRejectedValueOnce(new Error("listing unavailable"));
    const { promoteIncompleteApplicationAfterFeePaid } = await import("@/lib/promote-incomplete-application-after-fee.server");
    expect(await promoteIncompleteApplicationAfterFeePaid(makeDb() as never, session))
      .toMatchObject({ ok: false, error: expect.stringContaining("verify") });
    expect(upserts).toHaveLength(0);
  });

  it.each(["edited", "withdrawn", "deleted"])("does not promote a %s draft after its snapshot changes", async (transition) => {
    const { promoteIncompleteApplicationAfterFeePaid } = await import("@/lib/promote-incomplete-application-after-fee.server");
    const result = await promoteIncompleteApplicationAfterFeePaid(makeDb({ casRejected: true, beforeCas: () => {
      if (transition === "deleted") stored = [];
      else if (transition === "withdrawn") stored[0]!.row_data = { ...draft(), withdrawnAt: new Date().toISOString() };
      else stored[0]!.row_data = { ...draft(), application: { ...draft().application, roomChoice1: "other-room" } };
    } }) as never, session);
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("changed") });
    expect(stored[0]?.row_data).not.toMatchObject({ stage: "Submitted" });
  });
});
