// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

/**
 * `/api/stripe/connect/status` can refuse outright — a co-manager linked to two
 * owners (409) or an unreadable plan/link lookup (500) — and those bodies carry
 * only `{ error }`. Reading `canEditBankAccount` off such a body leaves bank
 * editing enabled (`undefined !== false`) and throws away the one sentence that
 * explains the refusal.
 */
const showToast = vi.fn();
vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => (req: { description?: unknown }) =>
    Promise.resolve(
      typeof window === "undefined"
        ? true
        : window.confirm(typeof req?.description === "string" ? req.description : "Are you sure?"),
    ),
 useAppUi: () => ({ showToast }) }));
vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => false, DEMO_MANAGER_USER_ID: "demo-manager" }));
vi.mock("@/lib/manager-subscription-client", () => ({
  loadManagerSubscriptionTierClient: vi.fn(async () => "pro"),
  loadManagerPaymentWaiverGrantedClient: vi.fn(async () => false),
}));
vi.mock("@/components/ui/modal", () => ({
  Modal: ({ open, children, footer }: { open: boolean; children: ReactNode; footer?: ReactNode }) =>
    open ? <div role="dialog">{children}{footer}</div> : null,
  ModalFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

import { ManagerPaymentSetupModal } from "@/components/portal/pro-payment-setup-modal";

const AMBIGUOUS =
  "You co-manage properties for more than one owner, so payouts must be set up from the owner's own account.";

function respond(url: string) {
  if (url.startsWith("/api/stripe/connect/status")) {
    return { ok: false, status: 409, json: async () => ({ error: AMBIGUOUS }) };
  }
  return { ok: true, status: 200, json: async () => ({ settings: null }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => respond(String(input))));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function mount() {
  await act(async () => {
    render(
      <ManagerPaymentSetupModal
        open
        onClose={vi.fn()}
        portalBase="/portal"
        propertyOptions={[{ id: "home", label: "Test home" }]}
        presetPropertyIds={["home"]}
      />,
    );
  });
}

it("carries no Payouts door of its own — nothing left here for an ambiguous co-manager refusal to gate (S022, captain 2026-09-27)", async () => {
  // PLAN-0920-0853 moved identity, bank and balance to the dedicated Payouts
  // page; the redundant quick-link row that used to sit in Payment setup
  // (and the `canEditBankAccount` refusal that gated it) was removed
  // entirely in the Payments settings simplification (S022) — Payouts is
  // reachable only through its own Settings tab now, which gates its own
  // access independently of this panel.
  await mount();
  expect(document.querySelector('[data-attr="manager-payment-stripe-link"]')).toBeNull();
  expect(document.querySelector('[data-attr="manager-payment-stripe-link-locked"]')).toBeNull();
});
