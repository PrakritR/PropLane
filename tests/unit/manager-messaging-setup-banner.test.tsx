// @vitest-environment jsdom
//
// The "set up messaging" notice used to render on ONE tab — the manager
// property preview — so a manager who never opened it never learned why their
// listings have no Text button and why nobody can text them. It is now a
// portal-wide banner in the same slot as the free-plan banner.
//
// A bar on every page has to earn it, so these cases are the whole contract:
// it appears only when there is something the manager can actually do, and it
// stays out of the way of the upgrade banner that owns that slot for a free
// account.
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

import type { ManagerMessagingNumberStatus } from "@/lib/sms/manager-messaging-number";

const statusState = vi.fn();
vi.mock("@/hooks/use-manager-messaging-number-status", () => ({
  useManagerMessagingNumberStatus: () => statusState(),
}));

import { ManagerMessagingSetupBanner } from "@/components/portal/messaging-setup-banner";

function status(
  overrides: Partial<ManagerMessagingNumberStatus> = {},
): ManagerMessagingNumberStatus {
  return {
    mode: "automatic",
    workspaceRole: "primary",
    provisioningAvailable: true,
    sendingAvailable: true,
    planTier: "paid",
    entitlement: { eligible: true, tier: "pro", source: "stripe" },
    number: null,
    canRequest: true,
    requestedAtSignup: false,
    canSend: false,
    personalPhone: { phone: null, verifiedAt: null, forwardInbound: false },
    ...overrides,
  };
}

function resolved(overrides: Partial<ManagerMessagingNumberStatus> = {}) {
  statusState.mockReturnValue({
    ready: true,
    resolved: true,
    statusError: false,
    status: status(overrides),
    retry: () => {},
  });
}

function banner() {
  return document.querySelector('[data-attr="manager-messaging-setup-banner"]');
}

afterEach(() => {
  cleanup();
  statusState.mockReset();
});

describe("the portal-wide messaging setup banner", () => {
  it("prompts a paid manager who has no number yet", () => {
    resolved();
    render(<ManagerMessagingSetupBanner />);
    expect(banner()).not.toBeNull();
    expect(
      screen.getByRole("link", { name: "Set up messaging" }),
    ).toHaveAttribute("href", "/portal/profile?tab=messaging");
  });

  it("goes away once a number is assigned", () => {
    resolved({
      number: {
        state: "active",
        registrationState: "approved",
        carrierRegistrationState: "registered",
        attachmentState: "attached",
        phoneNumber: "+12065550123",
        lastError: null,
      },
    });
    render(<ManagerMessagingSetupBanner />);
    expect(banner()).toBeNull();
  });

  it("still shows while a request exists but no number is assigned", () => {
    // A requested-but-unassigned number is the state the dogfood accounts sit
    // in, and renters STILL cannot text them — hiding here is how the notice
    // becomes invisible to the very people missing the channel. Settings is
    // where "waiting on the carrier" vs "waiting on eligibility" is explained.
    resolved({
      number: {
        state: "pending_registration",
        registrationState: "pending",
        carrierRegistrationState: "not_submitted",
        attachmentState: "not_attached",
        phoneNumber: null,
        lastError: null,
      },
      canRequest: false,
      provisioningAvailable: false,
    });
    render(<ManagerMessagingSetupBanner />);
    expect(banner()).not.toBeNull();
  });

  it("comes back when a request FAILED, which does need them", () => {
    resolved({
      number: {
        state: "failed",
        registrationState: "rejected",
        carrierRegistrationState: "failed",
        attachmentState: "failed",
        phoneNumber: null,
        lastError: null,
      },
    });
    render(<ManagerMessagingSetupBanner />);
    expect(banner()).not.toBeNull();
  });

  it("leaves the slot to the upgrade banner on a free account", () => {
    // Messaging is a paid feature, and that account is already being told to
    // upgrade in this very slot — two stacked bars say less than one.
    resolved({ planTier: "free" });
    render(<ManagerMessagingSetupBanner />);
    expect(banner()).toBeNull();
  });

  it("still prompts when the plan read failed, never the free path", () => {
    // Matching ManagerWorkNumberButton: `unknown` is a transient read failure,
    // not a confirmed free account.
    resolved({ planTier: "unknown" });
    render(<ManagerMessagingSetupBanner />);
    expect(banner()).not.toBeNull();
  });

  it("does not flash before the status resolves, or after it fails", () => {
    statusState.mockReturnValue({
      ready: true,
      resolved: false,
      statusError: false,
      status: null,
      retry: () => {},
    });
    const { unmount } = render(<ManagerMessagingSetupBanner />);
    expect(banner()).toBeNull();
    unmount();

    statusState.mockReturnValue({
      ready: true,
      resolved: true,
      statusError: true,
      status: null,
      retry: () => {},
    });
    render(<ManagerMessagingSetupBanner />);
    expect(banner()).toBeNull();
  });
});

describe("it reaches every page", () => {
  const layout = readFileSync("src/app/portal/layout.tsx", "utf8");
  const listing = readFileSync(
    "src/components/marketing/listing-detail-sections.tsx",
    "utf8",
  );

  it("is mounted by the portal layout, not one panel", () => {
    expect(layout).toContain("<ManagerMessagingSetupBanner />");
  });

  it("no longer double-renders inside the property preview", () => {
    expect(listing).not.toContain("listing-preview-messaging-setup-banner");
  });
});
