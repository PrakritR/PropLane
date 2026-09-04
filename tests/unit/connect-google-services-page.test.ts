/**
 * The post-signup Google step, after the captain's trim.
 *
 * It was three paragraphs of copy, two cards, and two footer buttons that did
 * the same thing — for a step that is entirely optional.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const page = readFileSync("src/app/auth/connect-google-services/page.tsx", "utf8");

describe("connect Google services", () => {
  it("offers one way forward, not two", () => {
    // "Skip for now" and "Enter portal" both POSTed `skip` and landed in the
    // portal; the only difference was that one was hidden until something was
    // connected, which made an optional step look consequential.
    expect(page).not.toContain("onboarding-skip-google-services");
    expect(page).not.toContain("onboarding-enter-portal");
    expect(page).toContain("onboarding-google-services-continue");
  });

  it("does not strand a manager when the write fails", () => {
    // The step is a preference, not a gate — navigation happens either way.
    expect(page).toContain('}).catch(() => undefined);\n      router.replace(portalDashboardPath("manager"));');
  });

  it("no longer advertises Zelle or Venmo", () => {
    // Those are being removed from the product and tracked by hand, so the
    // Gmail receipt-matching card has nothing left to offer here.
    expect(page).not.toMatch(/Zelle|Venmo/i);
    expect(page).not.toContain("onboarding-connect-gmail");
    expect(page).not.toContain("gmail-payments/connect");
  });

  it("keeps the copy short", () => {
    // The old page led with a four-line explainer that repeated the cards below.
    expect(page).not.toContain("You can connect either, both, or skip");
    expect(page).toContain('subtitle="Optional. You can do this later in Settings."');
  });

  it("still lets Calendar be connected, which is the point of the step", () => {
    expect(page).toContain("onboarding-connect-calendar");
    expect(page).toContain("google-calendar/connect");
  });
});
