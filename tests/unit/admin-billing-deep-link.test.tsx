// @vitest-environment jsdom
/**
 * The Subscribers menu links to `/admin/axis-users/manager-<id>/billing?action=promo|extend-trial`.
 * The account record's billing cards open the matching popup once billing has loaded, then ask the
 * page to drop the param.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { billingDialogForAction, ManagerBillingCards } from "@/components/portal/admin-manager-account-detail";
import type { AdminAccountBilling } from "@/lib/admin/admin-account-billing.server";

afterEach(() => cleanup());

const row = { id: "m1", tier: "pro", active: true, joinedAt: null };
const billing = {
  plan: { trialEndsAt: "2026-10-20", complimentary: false, promoCode: null },
  limits: { propertyCap: null },
  stripe: { available: true, customerUrl: null },
  payments: [],
  paidToDateCents: 0,
} as unknown as AdminAccountBilling;

function mount(props: { initialAction?: string | null; state?: "loading" | "ready" | "error"; consumed?: () => void }) {
  return render(
    <ManagerBillingCards
      row={row}
      billing={props.state === "loading" ? null : billing}
      billingState={props.state ?? "ready"}
      onChanged={() => {}}
      showToast={() => {}}
      initialAction={props.initialAction}
      onActionConsumed={props.consumed}
    />,
  );
}

describe("billing deep link", () => {
  it("maps the Subscribers menu actions to a popup and ignores anything else", () => {
    expect(billingDialogForAction("promo")).toBe("promo");
    expect(billingDialogForAction("extend-trial")).toBe("trial");
    expect(billingDialogForAction("comp")).toBeNull();
    expect(billingDialogForAction(null)).toBeNull();
  });

  it("?action=promo opens Apply promo code and clears the param", () => {
    const consumed = vi.fn();
    mount({ initialAction: "promo", consumed });
    expect(screen.getByText("Apply promo code", { selector: "h2, h3, [role=dialog] *" })).toBeTruthy();
    expect(document.querySelector('[data-attr="admin-billing-promo-dialog"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="admin-billing-trial-dialog"]')).toBeNull();
    expect(consumed).toHaveBeenCalledTimes(1);
  });

  it("?action=extend-trial opens Extend trial", () => {
    const consumed = vi.fn();
    mount({ initialAction: "extend-trial", consumed });
    expect(document.querySelector('[data-attr="admin-billing-trial-dialog"]')).not.toBeNull();
    expect(consumed).toHaveBeenCalledTimes(1);
  });

  it("waits for the billing read, and opens nothing without an action", () => {
    const consumed = vi.fn();
    mount({ initialAction: "promo", state: "loading", consumed });
    expect(document.querySelector('[data-attr="admin-billing-promo-dialog"]')).toBeNull();
    expect(consumed).not.toHaveBeenCalled();
    cleanup();
    mount({ initialAction: null });
    expect(document.querySelector('[data-attr="admin-billing-promo-dialog"]')).toBeNull();
  });

  it("the billing section reads ?action= and removes it from the URL", () => {
    const src = readFileSync(join(process.cwd(), "src/components/portal/admin-account-record-sections.tsx"), "utf8");
    expect(src).toContain('searchParams?.get("action")');
    expect(src).toContain('next.delete("action")');
    expect(src).toContain("initialAction={action}");
  });
});
