import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(join(process.cwd(), path), "utf8");
}

const ENTRY_POINT_FILES = [
  "src/components/portal/portal-payout-setup-card.tsx",
  "src/components/portal/pro-payment-setup-modal.tsx",
  "src/components/portal/portal-stripe-connect-panel.tsx",
];

describe("Payout entry points never open a hosted onboarding redirect", () => {
  it.each(ENTRY_POINT_FILES)("%s never navigates the page to a hosted /onboard URL", (path) => {
    const text = source(path);
    // A hosted redirect would leave the app entirely via a page navigation —
    // `window.location.href` / `.assign(` pointed at an "onboard" path. The
    // legitimate reconnect call in `portal-payout-setup-card.tsx` is a
    // `fetch("…/onboard", { method: "POST" })` API call, not a navigation,
    // so this only forbids the navigation shape.
    const navigatesToOnboard =
      /window\.location\.(href\s*=|assign\()[^;]*onboard/i.test(text);
    expect(navigatesToOnboard).toBe(false);
  });

  it("Payment setup no longer carries its own Payouts quick-link row (S022, captain 2026-09-27)", () => {
    const text = source("src/components/portal/pro-payment-setup-modal.tsx");
    // The row was a redundant shortcut once Payouts got its own Settings
    // entry (PLAN-0920-1500) — removed in the Payments settings
    // simplification. Payouts stays reachable through its own Settings tab
    // (`?tab=payouts`), never through a card inside Payment setup.
    expect(text).not.toMatch(/`\$\{portalBasePath\}\/profile\?tab=payouts`/);
    expect(text).not.toMatch(/`\$\{portalBasePath\}\/payments\/payouts`/);
    expect(text).not.toContain("manager-payment-stripe-link");
  });
});
