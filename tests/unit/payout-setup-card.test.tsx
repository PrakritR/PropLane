// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

vi.mock("@/components/ui/modal", () => ({
  Modal: ({ open, children, title }: { open: boolean; children: ReactNode; title: ReactNode }) =>
    open ? (
      <div role="dialog" aria-label={String(title)}>
        {children}
      </div>
    ) : null,
}));

const embeddedProps: { connectBase: string; component: string }[] = [];
vi.mock("@/components/stripe-connect-embedded", () => ({
  StripeConnectEmbedded: ({ connectBase, component, onExit }: { connectBase: string; component: string; onExit: () => void }) => {
    embeddedProps.push({ connectBase, component });
    return (
      <button type="button" data-attr="stub-embedded-exit" onClick={onExit}>
        exit
      </button>
    );
  },
}));

import { PortalPayoutSetupCard } from "@/components/portal/portal-payout-setup-card";

afterEach(() => {
  cleanup();
  embeddedProps.length = 0;
  vi.unstubAllGlobals();
});

describe("PortalPayoutSetupCard", () => {
  it("shows Verify / Link bank / Ready to pay out and opens onboarding on Verify", () => {
    const onReady = vi.fn();
    render(
      <PortalPayoutSetupCard
        connectBase="/api/stripe/connect"
        setup={{ identity: "needed", bank: "needed", ready: false }}
        onReady={onReady}
      />,
    );
    expect(screen.getByText("Verify identity")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Link bank" })).toBeInTheDocument();
    expect(screen.getByText("Ready to pay out")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Verify" }));
    expect(embeddedProps).toEqual([{ connectBase: "/api/stripe/connect", component: "account_onboarding" }]);

    fireEvent.click(screen.getByText("exit"));
    expect(onReady).toHaveBeenCalledTimes(1);
  });

  it("renders Done for a finished step and Needs attention for a pending identity check, with no buttons", () => {
    render(
      <PortalPayoutSetupCard
        connectBase="/api/stripe/connect"
        setup={{ identity: "pending", bank: "done", ready: false }}
        onReady={vi.fn()}
      />,
    );
    expect(screen.getByText("Needs attention")).toBeInTheDocument();
    expect(screen.getAllByText("Done")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Link bank" })).not.toBeInTheDocument();
  });

  it("offers Reconnect only when the saved account needs relinking, POSTs relink, then opens onboarding", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ mode: "embedded", accountId: "acct_fresh" }) });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <PortalPayoutSetupCard
        connectBase="/api/vendor/stripe-connect"
        setup={{ identity: "needed", bank: "needed", ready: false }}
        needsRelink
        onReady={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(embeddedProps).toHaveLength(1));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/vendor/stripe-connect/onboard");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ relink: true });
    expect(embeddedProps[0]).toEqual({ connectBase: "/api/vendor/stripe-connect", component: "account_onboarding" });
  });

  it("refreshes instead of onboarding when the server says the saved account is still healthy", async () => {
    const onReady = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 409, json: async () => ({ code: "CONNECT_ACCOUNT_HEALTHY" }) }),
    );
    render(
      <PortalPayoutSetupCard
        connectBase="/api/stripe/connect"
        setup={{ identity: "needed", bank: "needed", ready: false }}
        needsRelink
        onReady={onReady}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Reconnect" }));
    await waitFor(() => expect(onReady).toHaveBeenCalledTimes(1));
    expect(embeddedProps).toHaveLength(0);
  });

  it("draws no Reconnect control when the account is reachable", () => {
    render(
      <PortalPayoutSetupCard
        connectBase="/api/stripe/connect"
        setup={{ identity: "needed", bank: "needed", ready: false }}
        onReady={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Reconnect" })).not.toBeInTheDocument();
  });

  it("marks every step done when ready", () => {
    render(
      <PortalPayoutSetupCard
        connectBase="/api/vendor/stripe-connect"
        setup={{ identity: "done", bank: "done", ready: true }}
        onReady={vi.fn()}
      />,
    );
    expect(screen.getAllByText("Done")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Verify" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Link bank" })).not.toBeInTheDocument();
  });
});
