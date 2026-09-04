import { describe, expect, it } from "vitest";
import { SYSTEM_PROMPT } from "@/lib/agent/system-prompt";
import { RESIDENT_SYSTEM_PROMPT } from "@/lib/agent/resident-system-prompt";
import { GMAIL_PAYMENTS_ENABLED } from "@/lib/gmail-payments/enabled";

/**
 * PRP-133: the assistant had no product knowledge of the payment system, so it
 * could not say how money reaches the manager, why an ACH charge sits in
 * "processing", or — the reported symptom — why Gmail was being asked for to
 * track payments. Gmail receipt matching has since been withdrawn (PRP-130), so
 * the honest answer is that it is neither needed nor used.
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

  it("routes off-platform payments to mark_charge_paid rather than email scanning", () => {
    expect(SYSTEM_PROMPT).toContain("mark_charge_paid");
    expect(SYSTEM_PROMPT).toMatch(/Zelle, Venmo, cash, or check/);
  });

  it("states plainly that PropLane does not read email, matching the shipped flag", () => {
    // The prompt may only claim this while the feature really is off. If Gmail
    // payment matching is ever re-enabled, this prompt text becomes a lie and
    // must be rewritten with it.
    expect(GMAIL_PAYMENTS_ENABLED).toBe(false);
    expect(SYSTEM_PROMPT).toContain("currently switched OFF");
    expect(SYSTEM_PROMPT).toContain("no email is read");
    expect(SYSTEM_PROMPT).toContain("only Google connection offered today is Google Calendar");
    expect(RESIDENT_SYSTEM_PROMPT).toContain("does not read anyone's email");
  });
});
