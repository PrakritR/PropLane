import { describe, expect, it, vi } from "vitest";
import type Stripe from "stripe";
import {
  getIdentityRequirements,
  identityStatusFromAccount,
  submitIdentity,
} from "@/lib/stripe-connect-identity.server";

function mockStripe(account: Partial<Stripe.Account>, overrides: Partial<Stripe> = {}): Stripe {
  const full = { id: "acct_1", object: "account", ...account } as Stripe.Account;
  return {
    accounts: {
      retrieve: vi.fn().mockResolvedValue(full),
      update: vi.fn().mockResolvedValue(full),
      updatePerson: vi.fn().mockResolvedValue({ id: "person_1" }),
    },
    ...overrides,
  } as unknown as Stripe;
}

describe("getIdentityRequirements — requirements → spec mapping", () => {
  it("maps every supported requirement key to its field", async () => {
    const stripe = mockStripe({
      requirements: {
        currently_due: [
          "individual.first_name",
          "individual.last_name",
          "individual.dob.day",
          "individual.dob.month",
          "individual.dob.year",
          "individual.address.line1",
          "individual.address.city",
          "individual.ssn_last_4",
          "individual.id_number",
          "individual.phone",
          "individual.email",
          "business_type",
          "business_profile.url",
          "company.name",
          "company.address.line1",
          "company.phone",
          "company.tax_id",
          "individual.verification.document",
          "company.verification.document",
        ],
        past_due: [],
        pending_verification: [],
        disabled_reason: null,
      } as unknown as Stripe.Account.Requirements,
      details_submitted: false,
    });

    const result = await getIdentityRequirements(stripe, "acct_1");

    expect(result.fallbackToEmbedded).toBe(false);
    const keys = result.fields.map((f) => f.key).sort();
    expect(keys).toEqual(
      [
        "individual.legal_name",
        "individual.dob",
        "individual.address",
        "individual.ssn_last_4",
        "individual.id_number",
        "individual.phone",
        "individual.email",
        "business_type",
        "business_profile.url",
        "company.name",
        "company.address",
        "company.phone",
        "company.tax_id",
        "individual.verification.document",
        "company.verification.document",
      ].sort(),
    );
    // individual.dob.day/month/year all collapse onto ONE field spec.
    expect(result.fields.filter((f) => f.key === "individual.dob")).toHaveLength(1);
    const ssn = result.fields.find((f) => f.key === "individual.ssn_last_4");
    expect(ssn?.sensitive).toBe(true);
    const idNumber = result.fields.find((f) => f.key === "individual.id_number");
    expect(idNumber?.sensitive).toBe(true);
    const taxId = result.fields.find((f) => f.key === "company.tax_id");
    expect(taxId?.sensitive).toBe(true);
  });

  it("excludes external_account and tos_acceptance — those are never form fields", async () => {
    const stripe = mockStripe({
      requirements: {
        currently_due: ["external_account", "tos_acceptance.date", "individual.first_name"],
        past_due: [],
        pending_verification: [],
        disabled_reason: null,
      } as unknown as Stripe.Account.Requirements,
      details_submitted: false,
    });
    const result = await getIdentityRequirements(stripe, "acct_1");
    expect(result.fallbackToEmbedded).toBe(false);
    expect(result.fields.map((f) => f.key)).toEqual(["individual.legal_name"]);
  });

  it("never asks for business_profile.mcc — the platform sets the default at submit", async () => {
    const stripe = mockStripe({
      requirements: {
        currently_due: ["business_profile.mcc"],
        past_due: [],
        pending_verification: [],
        disabled_reason: null,
      } as unknown as Stripe.Account.Requirements,
      details_submitted: false,
    });
    const result = await getIdentityRequirements(stripe, "acct_1");
    expect(result.fallbackToEmbedded).toBe(false);
    expect(result.fields).toEqual([]);
  });

  it("flips fallbackToEmbedded for an unrecognized requirement key instead of dropping it", async () => {
    const stripe = mockStripe({
      requirements: {
        currently_due: ["individual.first_name", "some_future_stripe_requirement.field"],
        past_due: [],
        pending_verification: [],
        disabled_reason: null,
      } as unknown as Stripe.Account.Requirements,
      details_submitted: false,
    });
    const result = await getIdentityRequirements(stripe, "acct_1");
    expect(result.fallbackToEmbedded).toBe(true);
    // The known key still gets its field — unknown keys don't block the rest.
    expect(result.fields.map((f) => f.key)).toEqual(["individual.legal_name"]);
  });

  it("reports verified when nothing is due and details are submitted", async () => {
    const stripe = mockStripe({
      requirements: {
        currently_due: [],
        past_due: [],
        pending_verification: [],
        disabled_reason: null,
      } as unknown as Stripe.Account.Requirements,
      details_submitted: true,
    });
    const result = await getIdentityRequirements(stripe, "acct_1");
    expect(result.status).toBe("verified");
  });

  it("reports pending when Stripe is reviewing submitted verification", async () => {
    const stripe = mockStripe({
      requirements: {
        currently_due: [],
        past_due: [],
        pending_verification: ["individual.verification.document"],
        disabled_reason: null,
      } as unknown as Stripe.Account.Requirements,
      details_submitted: true,
    });
    const result = await getIdentityRequirements(stripe, "acct_1");
    expect(result.status).toBe("pending");
  });

  it("reports restricted for a non-requirements disabled reason (e.g. fraud review)", async () => {
    const stripe = mockStripe({
      requirements: {
        currently_due: [],
        past_due: [],
        pending_verification: [],
        disabled_reason: "rejected.fraud",
      } as unknown as Stripe.Account.Requirements,
      details_submitted: true,
    });
    const result = await getIdentityRequirements(stripe, "acct_1");
    expect(result.status).toBe("restricted");
  });

  it("distinguishes an application-collected account from a legacy express account", async () => {
    const applicationStripe = mockStripe({
      controller: { type: "application", stripe_dashboard: { type: "none" } } as unknown as Stripe.Account.Controller,
      requirements: { currently_due: [], past_due: [], pending_verification: [], disabled_reason: null } as unknown as Stripe.Account.Requirements,
      details_submitted: true,
    });
    const expressStripe = mockStripe({
      controller: { type: "application", stripe_dashboard: { type: "express" } } as unknown as Stripe.Account.Controller,
      requirements: { currently_due: [], past_due: [], pending_verification: [], disabled_reason: null } as unknown as Stripe.Account.Requirements,
      details_submitted: true,
    });
    expect((await getIdentityRequirements(applicationStripe, "acct_1")).isApplicationCollected).toBe(true);
    expect((await getIdentityRequirements(expressStripe, "acct_1")).isApplicationCollected).toBe(false);
  });
});

describe("identityStatusFromAccount — pure projection off an account already in hand", () => {
  it("computes the same status as getIdentityRequirements without a Stripe call", () => {
    const account = {
      id: "acct_1",
      object: "account",
      requirements: {
        currently_due: ["individual.ssn_last_4"],
        past_due: [],
        pending_verification: [],
        disabled_reason: null,
      },
      details_submitted: true,
    } as unknown as Stripe.Account;
    const snapshot = identityStatusFromAccount(account);
    expect(snapshot.status).toBe("needs_info");
    expect(snapshot.currentlyDue).toEqual(["individual.ssn_last_4"]);
  });
});

describe("submitIdentity — tokens for sensitive fields, plain values for the rest", () => {
  it("forwards account_token verbatim and never puts SSN/id-number digits in a plain accounts.update call", async () => {
    const stripe = mockStripe({
      requirements: { currently_due: [], past_due: [], pending_verification: [], disabled_reason: null } as unknown as Stripe.Account.Requirements,
      details_submitted: true,
    });

    const result = await submitIdentity(stripe, "acct_1", {
      accountToken: "acct_tok_abc123",
      fields: {
        business_type: "individual",
        // Defense in depth: even if a caller somehow sent these, they must
        // never reach a plain accounts.update call.
        "individual.ssn_last_4": "9999",
        "individual.id_number": "123456789",
      },
      tosAcceptance: { date: 1700000000, ip: "203.0.113.5", userAgent: "vitest" },
    });

    expect(result.ok).toBe(true);

    const updateMock = stripe.accounts.update as unknown as ReturnType<typeof vi.fn>;
    const calls = updateMock.mock.calls as unknown as Array<[string, Record<string, unknown>]>;

    // First call applies the token.
    expect(calls[0]![1]).toEqual({ account_token: "acct_tok_abc123" });

    // Every OTHER call's serialized args must not contain the sensitive digits.
    const otherCallsJson = JSON.stringify(calls.slice(1));
    expect(otherCallsJson).not.toContain("9999");
    expect(otherCallsJson).not.toContain("123456789");
  });

  it("stamps tos_acceptance from the caller-supplied (server-derived) date/ip/user agent on every submit", async () => {
    const stripe = mockStripe({
      requirements: { currently_due: [], past_due: [], pending_verification: [], disabled_reason: null } as unknown as Stripe.Account.Requirements,
      details_submitted: true,
    });
    await submitIdentity(stripe, "acct_1", {
      fields: { business_type: "individual" },
      tosAcceptance: { date: 1700000000, ip: "203.0.113.5", userAgent: "vitest-agent" },
    });
    const updateMock = stripe.accounts.update as unknown as ReturnType<typeof vi.fn>;
    const lastCall = updateMock.mock.calls[updateMock.mock.calls.length - 1]![1] as Record<string, unknown>;
    expect(lastCall.tos_acceptance).toEqual({ date: 1700000000, ip: "203.0.113.5", user_agent: "vitest-agent" });
  });

  it("applies a person_token via updatePerson when a personId is given", async () => {
    const stripe = mockStripe({
      requirements: { currently_due: [], past_due: [], pending_verification: [], disabled_reason: null } as unknown as Stripe.Account.Requirements,
      details_submitted: true,
    });
    await submitIdentity(stripe, "acct_1", {
      personToken: "person_tok_xyz",
      personId: "person_1",
      tosAcceptance: { date: 1700000000, ip: "203.0.113.5", userAgent: "vitest" },
    });
    expect(stripe.accounts.updatePerson).toHaveBeenCalledWith("acct_1", "person_1", { person_token: "person_tok_xyz" });
  });

  it("refuses a personToken with no personId", async () => {
    const stripe = mockStripe({
      requirements: { currently_due: [], past_due: [], pending_verification: [], disabled_reason: null } as unknown as Stripe.Account.Requirements,
      details_submitted: true,
    });
    const result = await submitIdentity(stripe, "acct_1", {
      personToken: "person_tok_xyz",
      tosAcceptance: { date: 1700000000, ip: "203.0.113.5", userAgent: "vitest" },
    });
    expect(result.ok).toBe(false);
  });
});
