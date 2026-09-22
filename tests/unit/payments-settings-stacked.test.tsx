// @vitest-environment jsdom
/**
 * PLAN-0920-0845 phase E — Payments settings drops the "Settings" area
 * dropdown (Payment setup / Incoming / Outgoing / Late fees, one at a time)
 * in favor of five always-visible, separately-tagged stacked sections:
 * Payment setup, Processing fee, Late fees, Incoming reminders, Outgoing
 * reminders. The Stripe "Finish setup" pill and its orange sentence — the
 * two elements the phase's build note called out — are gone for the
 * incomplete-onboarding state. PLAN-0920-0853 later replaced the Stripe card
 * itself with a plain "Payouts" door to a dedicated page (identity, bank and
 * balance all live there now), so the row's own incomplete-state wording is
 * the plain "Set up" word, not a "Finish setup →" link — the row itself
 * still stays reachable, which is what this file's last test now checks.
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

  it("renders Payment setup, Processing fee, Late fees, Incoming reminders, Outgoing reminders in that order", () => {
    const body = paymentsSettingsPanelSource();
    const titles = ["Payment setup", "Processing fee", "Late fees", "Incoming reminders", "Outgoing reminders"];
    const positions = titles.map((title) => {
      const idx = body.indexOf(`title="${title}"`);
      expect(idx, `missing section titled "${title}"`).toBeGreaterThan(-1);
      return idx;
    });
    for (let i = 1; i < positions.length; i += 1) {
      expect(positions[i], `"${titles[i]}" is not after "${titles[i - 1]}"`).toBeGreaterThan(positions[i - 1]);
    }
  });

  it("gives each of the five sections a scope-bar-fed source tag", () => {
    const body = paymentsSettingsPanelSource();
    expect(body).toContain('<SettingsGroupSourceTag namespace="processing-fee-settings" />');
    expect(body).toContain('<SettingsGroupSourceTag namespace="incoming-payment-reminders" />');
    expect(body).toContain('<SettingsGroupSourceTag namespace="outgoing-payment-reminders" />');
    // Late fees has no workspace/account rung, so it carries its own always-"property"
    // tag (computed from the module's resolved scope) rather than the generic
    // by-namespace lookup — same vocabulary (`scopeTagLabel`), correct count.
    expect(body).toContain('scopeTagLabel("property", lateFeePropertyCount)');
    // "Payment setup" itself (Stripe payouts) has no scope rung to tag —
    // account-only — so it alone carries none.
    const setupSection = body.slice(body.indexOf('title="Payment setup"'), body.indexOf('title="Processing fee"'));
    expect(setupSection).not.toContain("SettingsGroupSourceTag");
  });
});

describe("ManagerPaymentSetupPanel: the incomplete-onboarding pill and sentence are gone", () => {
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

  it("shows no pill on the Stripe card while onboarding is incomplete", async () => {
    await mountIncomplete();
    const card = document.querySelector('[data-testid="payment-setup-stripe-card"]');
    expect(card).toBeTruthy();
    expect(card!.querySelector("span.rounded-full")).toBeNull();
  });

  it("shows no orange sentence while onboarding is incomplete", async () => {
    await mountIncomplete();
    expect(screen.queryByText(/Finish onboarding \(identity \+ bank details\)/)).not.toBeInTheDocument();
  });

  it("keeps the payouts row reachable, showing Set up while onboarding is incomplete", async () => {
    await mountIncomplete();
    const card = screen.getByTestId("payment-setup-stripe-card");
    expect(card.tagName).toBe("BUTTON");
    expect(card).toHaveTextContent("Set up");
  });
});

describe("ManagerPaymentSetupPanel: autopay rows render once across the split setup+fee mount", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows each autopay row label exactly once when Payments settings mounts both section=\"setup\" and section=\"fee\" (PaymentsSettingsPanel's actual shape)", async () => {
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
    expect(screen.getAllByText("Autopay retries a declined payment")).toHaveLength(1);
  });
});
