import { describe, expect, it } from "vitest";

import { paymentFailureCopy } from "@/lib/payments/payment-error-copy";

/**
 * A prospective tenant, at the moment of paying, was shown "Stripe is not
 * configured on the server (missing STRIPE_SECRET_KEY)." with a Try again
 * button that could not help (PRP-207); a resident was shown a raw server
 * string for a bill the product had told them they could pay, because nothing
 * read the `MANAGER_NO_CONNECT_ACCOUNT` code the server was already sending
 * (PRP-253).
 */
describe("paymentFailureCopy", () => {
  it("never lets an environment-variable name reach the payer", () => {
    const copy = paymentFailureCopy({
      code: "STRIPE_NOT_CONFIGURED",
      status: 503,
      serverMessage: "Stripe is not configured on the server (missing STRIPE_SECRET_KEY).",
    });
    expect(copy.message).not.toContain("STRIPE_SECRET_KEY");
    expect(copy.message).toContain("temporarily unavailable");
  });

  it("does not offer a retry that cannot work", () => {
    // The key will still be missing on the next click.
    expect(paymentFailureCopy({ code: "STRIPE_NOT_CONFIGURED" }).canRetry).toBe(false);
    expect(paymentFailureCopy({ code: "MANAGER_NO_CONNECT_ACCOUNT" }).canRetry).toBe(false);
  });

  it("says whose problem it is when the manager's setup is the blocker", () => {
    const copy = paymentFailureCopy({ code: "MANAGER_NO_CONNECT_ACCOUNT", status: 422 });
    expect(copy.blockedByManagerSetup).toBe(true);
    expect(copy.message).toMatch(/property manager/i);
    expect(copy.message).not.toMatch(/connect|stripe/i);
  });

  it("strips an env-var-shaped token even from an unrecognised message", () => {
    const copy = paymentFailureCopy({ status: 400, serverMessage: "Missing NEXT_PUBLIC_THING." });
    expect(copy.message).not.toContain("NEXT_PUBLIC_THING");
  });

  it("treats any 5xx as an ops fact, not a sentence for the payer", () => {
    const copy = paymentFailureCopy({ status: 500, serverMessage: "boom in handler" });
    expect(copy.message).not.toContain("boom");
    expect(copy.canRetry).toBe(true);
  });

  it("passes through a 4xx that really was written for the payer", () => {
    const copy = paymentFailureCopy({ status: 400, serverMessage: "That charge has already been paid." });
    expect(copy.message).toBe("That charge has already been paid.");
  });

  it("refuses a dump masquerading as a message", () => {
    const copy = paymentFailureCopy({ status: 400, serverMessage: "x".repeat(400) });
    expect(copy.message).toBe("We couldn't start the payment. Nothing has been charged.");
  });

  it("always says nothing was charged, on every generic path", () => {
    for (const input of [{}, { status: 500 }, { status: 400, serverMessage: "" }]) {
      expect(paymentFailureCopy(input).message).toMatch(/nothing has been charged/i);
    }
  });
});

describe("both payment surfaces go through it", () => {
  const FILES = [
    "src/components/portal/resident-payments-panel.tsx",
    "src/components/marketing/application-fee-inline-payment.tsx",
  ];

  it("neither renders the server's error string directly", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    for (const file of FILES) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source).toContain("paymentFailureCopy({");
      // The two shapes that used to leak it.
      expect(source).not.toContain('typeof payload.error === "string" ? payload.error :');
      expect(source).not.toContain("setError(data.error ??");
    }
  });

  it("the resident surface offers a way to reach the manager who must fix it", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(process.cwd(), "src/components/portal/resident-payments-panel.tsx"),
      "utf8",
    );
    expect(source).toContain("blockedByManagerSetup");
    expect(source).toContain("Message your property manager");
  });

  it("the applicant surface hides a retry that cannot work", async () => {
    const { readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const source = readFileSync(
      join(process.cwd(), "src/components/marketing/application-fee-inline-payment.tsx"),
      "utf8",
    );
    expect(source).toContain("{canRetry ? (");
  });
});
