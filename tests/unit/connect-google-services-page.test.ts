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

  /**
   * The unconfigured state showed an alert-styled panel reading "Google sign-in
   * is not set up on this server yet" — on a step the card above calls optional
   * (PRP-188). It read as an error about something the manager had just been
   * told to skip, it named SIGN-IN when this step connects CALENDAR, and "this
   * server" is a deployment fact nobody reading it can act on.
   */
  it("says Calendar, never sign-in, when the integration is unavailable", () => {
    expect(page).not.toContain("Google sign-in is not set up");
    expect(page).not.toContain("on this server yet");
    // `&apos;` in the JSX source, not a literal apostrophe.
    expect(page).toContain("Calendar sync isn&apos;t available in this environment");
  });

  it("uses quiet helper text rather than an alert panel", () => {
    // The Connect button is already disabled in this state, so the banner was
    // saying something the UI already showed — in a colour that means "wrong".
    expect(page).not.toContain("BANNER_INFO_CLASS");
    expect(page).toContain('data-attr="onboarding-calendar-unavailable"');
    expect(page).toContain("disabled={!status.calendarConfigured}");
  });

  it("only shows for first-time account setup and keeps setup inline", () => {
    expect(page).toContain("!body.pending");
    expect(page).not.toContain("router.push");
    expect(page).not.toContain("Open Settings");
    expect(page).toContain("ManagerOnboardingPhoneSetup");
    expect(page).toContain("ManagerOnboardingWorkNumberSetup");
    expect(page).toContain("ManagerOnboardingAssistantEmailSetup");
  });

  it("right-aligns Continue to portal", () => {
    expect(page).toContain('className="mt-6 flex justify-end"');
    expect(page).toContain("Continue to portal");
  });
});
