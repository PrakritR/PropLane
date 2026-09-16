import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT } from "@/lib/agent/system-prompt";
import { RESIDENT_SYSTEM_PROMPT } from "@/lib/agent/resident-system-prompt";

/**
 * PRP-133: the assistant had no product knowledge of the payment system, so it
 * could not say how money reaches the manager, why an ACH charge sits in
 * "processing", or — the reported symptom — why Gmail was being asked for to
 * track payments. Gmail receipt matching and off-platform (Zelle/Venmo) payments
 * were removed outright (PLAN-0916), so the honest answer is that neither exists.
 */
describe("PRP-133: assistant payment-system context", () => {
  it("teaches the manager assistant where the money lands and who bears the fee", () => {
    expect(SYSTEM_PROMPT).toContain("connected Stripe account");
    expect(SYSTEM_PROMPT).toContain("Settings > Payment setup");
    // Pass-through, never a markup — a manager asking "what do you charge me"
    // must not be told a made-up percentage.
    expect(SYSTEM_PROMPT).toContain("never a PropLane markup");
  });

  it("explains the ACH clearing window so a processing charge is not chased", () => {
    expect(SYSTEM_PROMPT).toContain("3-5 business days");
    expect(SYSTEM_PROMPT).toContain("processing");
    expect(SYSTEM_PROMPT).toContain("is NOT late");
    expect(RESIDENT_SYSTEM_PROMPT).toContain("3-5 business days");
  });

  it("routes a hand-taken payment to mark_charge_paid and never mentions retired channels", () => {
    expect(SYSTEM_PROMPT).toContain("mark_charge_paid");
    expect(SYSTEM_PROMPT).toMatch(/cash or check/);
    expect(SYSTEM_PROMPT).not.toMatch(/zelle|venmo/i);
    expect(RESIDENT_SYSTEM_PROMPT).not.toMatch(/zelle|venmo/i);
  });

  it("states plainly that PropLane does not read email", () => {
    expect(SYSTEM_PROMPT).toContain("There is no Gmail or email-receipt tracking");
    expect(SYSTEM_PROMPT).toContain("only Google connection offered is Google Calendar");
    expect(RESIDENT_SYSTEM_PROMPT).toContain("Every rent payment goes through PropLane");
  });
});
