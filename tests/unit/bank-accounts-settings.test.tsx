// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: vi.fn() }),
  useOptionalAppUi: () => null,
}));
vi.mock("@/components/stripe-connect-embedded", () => ({
  StripeConnectEmbedded: ({ component, onExit }: { component: string; onExit?: () => void }) => (
    <button type="button" data-attr="stub-onboarding" onClick={() => onExit?.()}>
      {component}
    </button>
  ),
}));
vi.mock("@/components/portal/payout-bank-sheet", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/components/portal/payout-bank-sheet")>(),
  PayoutBankSheet: ({ open }: { open: boolean }) => (open ? <div data-attr="stub-bank-sheet">bank sheet</div> : null),
}));
vi.mock("@/lib/native/detect-native", () => ({ isNativeRuntimeSync: () => false }));

import { PortalPayoutsSettingsPage } from "@/components/portal/portal-payouts-settings-page";
import { AddBankFlow, addBankFlowStart } from "@/components/portal/add-bank-flow";
import { removeDefaultRefusal } from "@/lib/stripe-external-accounts.server";

type Dest = { id: string; kind: "bank" | "card"; label: string; last4: string; status: string; default: boolean };

const chase: Dest = { id: "ba_1", kind: "bank", label: "Chase", last4: "1487", status: "verified", default: true };
const wells: Dest = { id: "ba_2", kind: "bank", label: "Wells Fargo", last4: "9921", status: "verified", default: false };

function balance(opts: { identity?: "done" | "needed"; bank?: boolean } = {}) {
  const identity = opts.identity ?? "done";
  return {
    currency: "usd",
    availableCents: 100_000,
    withdrawableCents: 100_000,
    heldCents: 0,
    instantAvailableCents: 0,
    pendingCents: 0,
    onTheWayCents: 0,
    bank: opts.bank ? { last4: "1487", bankName: "Chase", accountType: "checking", instantEligible: false, verifiedAt: "2026-09-12T00:00:00.000Z" } : null,
    schedule: { interval: "weekly", nextPayoutAt: null },
    setup: { identity, bank: opts.bank ? "done" : "needed", ready: identity === "done" && Boolean(opts.bank) },
    history: [],
  };
}

type Calls = { url: string; method: string; body: unknown }[];

function stubFetch(opts: { destinations: Dest[]; bal?: ReturnType<typeof balance>; afterOnboarding?: Dest[] }) {
  const calls: Calls = [];
  let onboardingDone = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (url.endsWith("/payouts/balance")) {
        return new Response(JSON.stringify(opts.bal ?? balance({ bank: opts.destinations.length > 0 })), { status: 200 });
      }
      if (url.endsWith("/bank-accounts") && method === "GET") {
        const list = onboardingDone && opts.afterOnboarding ? opts.afterOnboarding : opts.destinations;
        return new Response(JSON.stringify({ destinations: list }), { status: 200 });
      }
      if (url.includes("/bank-accounts/")) return new Response(JSON.stringify({ ok: true }), { status: 200 });
      if (url.includes("comms-credit-pool")) return new Response(JSON.stringify({ purchases: [] }), { status: 200 });
      return new Response(JSON.stringify({}), { status: 200 });
    }),
  );
  return { calls, markOnboardingDone: () => (onboardingDone = true) };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openRowMenu(name: string) {
  fireEvent.keyDown(screen.getByRole("button", { name: `Actions for ${name}` }), { key: "Enter" });
  await screen.findAllByRole("menuitem");
  // destructive items ignore taps for a short settle window after the menu opens
  await new Promise((resolve) => setTimeout(resolve, 200));
}

describe("Balance & payouts — no bank, one bank, several", () => {
  it("no bank: Withdraw is off, the bank + is the fix, and there is no Set up checklist", async () => {
    stubFetch({ destinations: [] });
    render(<PortalPayoutsSettingsPage portal="manager" />);
    await screen.findByText("No bank account yet");
    expect(screen.getByRole("button", { name: "Withdraw" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Add a bank account" })).toBeEnabled();
    expect(screen.queryByText("Set up")).not.toBeInTheDocument();
    expect(screen.queryByText("Verify identity")).not.toBeInTheDocument();
    expect(screen.queryByText("Withdraw to")).not.toBeInTheDocument();
  });

  it("one bank: it is the default row, has one ⋯, and Withdraw is on", async () => {
    stubFetch({ destinations: [chase] });
    render(<PortalPayoutsSettingsPage portal="manager" />);
    await screen.findAllByText(/Chase ····1487/);
    expect(screen.getByText("Default")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /^Actions for / })).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Withdraw" })).toBeEnabled();
    expect(screen.getByText("Withdraw to")).toBeInTheDocument();
  });

  it("several banks: Default marks only the default row and Withdraw to preselects it", async () => {
    stubFetch({ destinations: [chase, wells] });
    render(<PortalPayoutsSettingsPage portal="manager" />);
    await screen.findByText(/Wells Fargo ····9921/);
    expect(screen.getAllByText("Default")).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: /^Actions for / })).toHaveLength(2);
    const withdrawTo = screen.getByRole("button", { name: "Withdraw to" });
    expect(withdrawTo).toHaveTextContent("Chase ····1487");
  });
});

describe("Bank row ⋯ menu", () => {
  it("Make default calls the server with only the bank id, and the default row has no Make default", async () => {
    const { calls } = stubFetch({ destinations: [chase, wells] });
    render(<PortalPayoutsSettingsPage portal="manager" />);
    await screen.findByText(/Wells Fargo ····9921/);

    await openRowMenu("Chase ····1487");
    expect(screen.queryByRole("menuitem", { name: "Make default" })).not.toBeInTheDocument();
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
    cleanup();

    stubFetch({ destinations: [chase, wells] });
    render(<PortalPayoutsSettingsPage portal="manager" />);
    await screen.findByText(/Wells Fargo ····9921/);
    await openRowMenu("Wells Fargo ····9921");
    const items = screen.getAllByRole("menuitem").map((el) => el.textContent);
    expect(items).toEqual(["Make default", "Remove"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Make default" }));
    await waitFor(() => {
      const patch = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PATCH");
      expect(patch).toBeDefined();
      expect(String(patch![0])).toBe("/api/stripe/connect/bank-accounts/ba_2");
      expect(JSON.parse(String((patch![1] as RequestInit).body))).toEqual({ default: true });
    });
    expect(calls.length).toBeGreaterThan(0);
  });

  it("Remove on the default while other banks exist is refused in the confirm and never calls the server", async () => {
    stubFetch({ destinations: [chase, wells] });
    render(<PortalPayoutsSettingsPage portal="manager" />);
    await screen.findByText(/Wells Fargo ····9921/);
    await openRowMenu("Chase ····1487");
    fireEvent.click(screen.getByRole("menuitem", { name: "Remove" }));
    expect((await screen.findAllByText("Make another account the default before removing this one.")).length).toBeGreaterThan(0);
    const confirm = screen.getByRole("button", { name: "Remove" });
    expect(confirm).toBeDisabled();
    fireEvent.click(confirm);
    const deletes = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "DELETE");
    expect(deletes).toHaveLength(0);
  });
});

describe("Add bank flow branches on onboarding readiness", () => {
  it("addBankFlowStart: identity not done goes to onboarding; done or in review goes to the bank sheet", () => {
    expect(addBankFlowStart("needed")).toBe("onboarding");
    expect(addBankFlowStart(null)).toBe("onboarding");
    expect(addBankFlowStart("done")).toBe("bank");
    expect(addBankFlowStart("pending")).toBe("bank");
  });

  it("not ready: opens Stripe's embedded onboarding; leaving it with no bank continues into the bank sheet", async () => {
    stubFetch({ destinations: [], bal: balance({ identity: "needed" }) });
    render(<AddBankFlow open onClose={() => {}} portal="manager" />);
    const onboarding = await screen.findByText("account_onboarding");
    expect(screen.queryByText("bank sheet")).not.toBeInTheDocument();
    fireEvent.click(onboarding);
    expect(await screen.findByText("bank sheet")).toBeInTheDocument();
  });

  it("the onboarding popup is one full-width body: no context rail and no preview pane to squeeze Stripe's component", async () => {
    stubFetch({ destinations: [], bal: balance({ identity: "needed" }) });
    render(<AddBankFlow open onClose={() => {}} portal="manager" />);
    await screen.findByText("account_onboarding");
    expect(document.querySelector("[data-popup-form]")).not.toBeNull();
    expect(document.querySelector("[data-popup-context]")).toBeNull();
    expect(document.querySelector("[data-popup-preview]")).toBeNull();
  });

  it("not ready: leaving onboarding with a bank already added closes the flow and reports it", async () => {
    const onClose = vi.fn();
    const onAdded = vi.fn();
    const { markOnboardingDone } = stubFetch({ destinations: [], afterOnboarding: [chase], bal: balance({ identity: "needed" }) });
    render(<AddBankFlow open onClose={onClose} portal="manager" onAdded={onAdded} />);
    const onboarding = await screen.findByText("account_onboarding");
    markOnboardingDone();
    fireEvent.click(onboarding);
    await waitFor(() => expect(onAdded).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
    expect(screen.queryByText("bank sheet")).not.toBeInTheDocument();
  });

  it("ready: opens the in-app bank sheet directly, no onboarding", async () => {
    stubFetch({ destinations: [chase] });
    render(<AddBankFlow open onClose={() => {}} portal="manager" />);
    expect(await screen.findByText("bank sheet")).toBeInTheDocument();
    expect(screen.queryByText("account_onboarding")).not.toBeInTheDocument();
  });

  it("the Bank accounts + on the page routes through the same flow", async () => {
    stubFetch({ destinations: [chase] });
    render(<PortalPayoutsSettingsPage portal="manager" />);
    await screen.findAllByText(/Chase ····1487/);
    fireEvent.click(screen.getByRole("button", { name: "Add a bank account" }));
    expect(await screen.findByText("bank sheet")).toBeInTheDocument();
  });
});

describe("removeDefaultRefusal (server rule)", () => {
  const list = [
    { id: "ba_1", default_for_currency: true },
    { id: "ba_2", default_for_currency: false },
  ];
  it("refuses removing the default while another account exists", () => {
    expect(removeDefaultRefusal(list, "ba_1")).toMatch(/default/i);
  });
  it("allows removing a non-default account", () => {
    expect(removeDefaultRefusal(list, "ba_2")).toBeNull();
  });
  it("allows removing the only account, default or not", () => {
    expect(removeDefaultRefusal([{ id: "ba_1", default_for_currency: true }], "ba_1")).toBeNull();
  });
});
