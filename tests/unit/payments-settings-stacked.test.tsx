// @vitest-environment jsdom
/**
 * PLAN-0920-0845 phase E — Payments settings drops the "Settings" area
 * dropdown (Payment setup / Incoming / Outgoing / Late fees, one at a time)
 * in favor of three always-visible, separately-tagged stacked sections:
 * Payment setup, Processing fee, Late fees (S022, captain 2026-09-27, dropped
 * the reminders link along with the retry choice, the upcoming-charges
 * toggle, and — PLAN-0920-0853's Stripe-card-turned-door — the redundant
 * Payouts quick-link row; Payouts has its own Settings tab).
 */
import { readFileSync } from "node:fs";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { showToast } = vi.hoisted(() => ({ showToast: vi.fn() }));

vi.mock("@/components/providers/app-ui-provider", () => ({
  useConfirm: () => () => Promise.resolve(true),
  useAppUi: () => ({ showToast }),
}));
vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => false }));
vi.mock("@/lib/manager-subscription-client", () => ({
  loadManagerSubscriptionTierClient: vi.fn(async () => "pro"),
  loadManagerPaymentWaiverGrantedClient: vi.fn(async () => false),
}));
// PLAN-0920-2357 stream C: an owned active workspace so `activeWorkspaceId` is
// truthy in both split mounts below — the autopay row only renders once one
// exists, and the duplicate-row bug only reproduces once it does.
vi.mock("@/components/portal/workspace-provider", () => ({
  useWorkspaces: () => ({
    workspaces: [
      {
        id: "ws1",
        name: "Workspace",
        ownerUserId: "owner-1",
        owned: true,
        isDefault: true,
        propertyIds: [],
        propertyPermissions: {},
      },
    ],
    active: {
      id: "ws1",
      name: "Workspace",
      ownerUserId: "owner-1",
      owned: true,
      isDefault: true,
      propertyIds: [],
      propertyPermissions: {},
    },
    plan: null,
    error: null,
    loading: false,
    refresh: vi.fn(),
    mutate: vi.fn(),
    select: vi.fn(),
  }),
}));

import { ManagerPaymentSetupPanel } from "@/components/portal/pro-payment-setup-modal";

const SRC = readFileSync(`${process.cwd()}/src/components/portal/pro-portal-settings-panels.tsx`, "utf8");

function paymentsSettingsPanelSource(): string {
  const start = SRC.indexOf("export function PaymentsSettingsPanel(");
  expect(start, "PaymentsSettingsPanel missing").toBeGreaterThan(-1);
  const end = SRC.indexOf("\nexport function CommunicationSettingsPanel(", start);
  expect(end, "could not bound PaymentsSettingsPanel's body").toBeGreaterThan(start);
  return SRC.slice(start, end);
}

describe("Payments settings: stacked sections replace the area dropdown", () => {
  it("drops the Settings area dropdown", () => {
    const body = paymentsSettingsPanelSource();
    expect(body).not.toContain("payments-settings-area");
    expect(body).not.toContain("PAYMENTS_SETTINGS_AREAS");
    expect(body).not.toMatch(/PaymentsSettingsArea/);
  });

  it("renders setup and receiving links while account fees and property late fees live at their destinations", () => {
    const body = paymentsSettingsPanelSource();
    const titles = ["Receiving from residents"];
    const positions = titles.map((title) => {
      const idx = body.indexOf(`title="${title}"`);
      expect(idx, `missing section titled "${title}"`).toBeGreaterThan(-1);
      return idx;
    });
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i], `"${titles[i]}" is not after "${titles[i - 1]}"`).toBeGreaterThan(positions[i - 1]);
    }
    expect(body).not.toContain('title="Incoming reminders"');
    expect(body).not.toContain('title="Outgoing reminders"');
    // S022 (captain 2026-09-27): the reminders link left the resident-facing
    // (incoming/default) Payments settings pane — reminders are fixed
    // everywhere now (see `WhatProplaneSends`, Settings → Communication), so
    // there is nothing left here to link out to. `mode="outgoing"` is a
    // separate, non-Settings-nav surface (out of scope) and keeps its link.
    const incoming = body.slice(body.indexOf('title="Receiving from residents"'));
    expect(incoming).not.toContain("Edit reminder timing and automated messages");
    expect(incoming).not.toContain("payments-open-reminders-hub");
  });

  it("links to the account processing-fee default and has no listing late-fee editor", () => {
    const body = paymentsSettingsPanelSource();
    expect(body).toContain('/portal/profile?tab=account');
    expect(body).toContain('label="Processing fee paid by"');
    expect(body).not.toContain('title="Processing fee"');
    expect(body).not.toContain('title="Late fees"');
    expect(body).not.toContain('PaymentListingLateFeeSettings');
  });
});

describe("ManagerPaymentSetupPanel: the Payouts quick-link card is gone (S022, captain 2026-09-27)", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  async function mountIncomplete() {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/stripe/connect/status")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ connected: true, chargesEnabled: false, payoutsEnabled: false, paymentReady: false }),
          };
        }
        return { ok: true, status: 200, json: async () => ({ settings: null }) };
      }),
    );
    await act(async () => {
      render(<ManagerPaymentSetupPanel active propertyOptions={[{ id: "home", label: "Test home" }]} />);
    });
  }

  it("renders no Payouts card at all, in any onboarding state — Payouts has its own Settings tab now", async () => {
    await mountIncomplete();
    expect(document.querySelector('[data-testid="payment-setup-stripe-card"]')).toBeNull();
    expect(document.querySelector('[data-testid="payment-setup-stripe-card-locked"]')).toBeNull();
    expect(screen.queryByText(/Finish onboarding \(identity \+ bank details\)/)).not.toBeInTheDocument();
  });
});

describe("ManagerPaymentSetupPanel: autopay rows render once across the split setup+fee mount", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows the autopay row label exactly once when Payments settings mounts both section=\"setup\" and section=\"fee\" (PaymentsSettingsPanel's actual shape)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.startsWith("/api/stripe/connect/status")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ connected: true, chargesEnabled: true, payoutsEnabled: true, paymentReady: true }),
          };
        }
        return { ok: true, status: 200, json: async () => ({ settings: null }) };
      }),
    );
    await act(async () => {
      render(
        <>
          <ManagerPaymentSetupPanel active section="setup" propertyOptions={[{ id: "home", label: "Test home" }]} />
          <ManagerPaymentSetupPanel active section="fee" propertyOptions={[{ id: "home", label: "Test home" }]} />
        </>,
      );
    });

    expect(screen.getAllByText("Residents can set up autopay")).toHaveLength(1);
    // The retry choice left this row entirely (S022, captain 2026-09-27) —
    // autopay always retries once, 3 days later, with no control for it.
    expect(screen.queryByText("Autopay retries a declined payment")).toBeNull();
  });
});
