// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

let search = "";
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/portal/financials/owner-payouts",
  useSearchParams: () => new URLSearchParams(search),
}));

import { OwnerPayoutsPanel, shiftMonthKey, useOwnerPayoutsAllowed } from "@/components/portal/finances/owner-payouts-panel";
import { invalidateSharedGets } from "@/lib/shared-get-cache";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const TERMS = { ownerShareBps: 9000, appliesTo: "rent", leasingFeeBps: 0, minFeeCents: 0, reserveTargetCents: 10_000, repairApprovalThresholdCents: 25_000 };

function view(over: Record<string, unknown> = {}) {
  return {
    workspace: { id: "ws-1", name: "Maple Court" },
    policy: { id: "pol-1", status: "active", feeLine: "You receive 90%, PropLane keeps 10% of rent", terms: TERMS, signedAt: "2026-10-01T00:00:00Z" },
    month: "2026-10",
    balance: { balanceCents: 250_000, availableCents: 240_000, pendingCents: 30_000, reserveCents: 10_000 },
    statement: {
      fromIso: "2026-10-01T07:00:00Z",
      toIso: "2026-11-01T07:00:00Z",
      beginningCents: 100_000,
      rows: [
        { id: "r1", date: "2026-10-03T10:00:00Z", kind: "rent", label: "Rent collected", amountCents: 100_000, propertyLabel: "12 Maple St" },
        { id: "r2", date: "2026-10-03T10:00:00Z", kind: "fee", label: "PropLane fee", amountCents: -10_000 },
        { id: "r3", date: "2026-10-05T10:00:00Z", kind: "vendor_charge", label: "Leaky tap · Pipes Co", amountCents: -12_000, href: "/portal/services/abc", propertyId: "house-1" },
      ],
      totals: { rentGrossCents: 100_000, feeCents: -10_000, vendorChargesCents: -12_000, otherCents: 0, netCents: 78_000, withdrawalsCents: 0 },
      endingCents: 178_000,
    },
    pendingApprovals: [{ id: "exp-1", workspaceId: "ws-1", title: "Roof patch", vendorLabel: "Top Roofing", amountCents: 40_000, propertyId: null, requestedAt: "2026-10-10T10:00:00Z" }],
    withdrawals: [{ id: "w1", amountCents: 50_000, status: "completed", createdAt: "2026-10-08T10:00:00Z", payoutPending: false }],
    payoutReady: true,
    occupancy: { houses: 1, units: 6, occupied: 5 },
    ...over,
  };
}

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
let currentView: ReturnType<typeof view>;
let writeResponses: Record<string, Response | (() => Response)> = {};

function installFetch(list: unknown = { workspaces: [{ id: "ws-1", name: "Maple Court", status: "active", feeLine: "x" }], waiting: [] }) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method !== "GET") {
        const r = writeResponses[`${method} ${url}`];
        if (r) return typeof r === "function" ? r() : r;
        return json(200, { ok: true });
      }
      if (url === "/api/owner/finances") return json(200, list);
      if (url.startsWith("/api/owner/finances?workspace=")) return json(200, currentView);
      return json(404, { error: "Not found." });
    }),
  );
}

beforeEach(() => {
  invalidateSharedGets();
  search = "";
  currentView = view();
  writeResponses = {};
  let n = 0;
  vi.stubGlobal("crypto", { ...globalThis.crypto, randomUUID: () => `key-${++n}` });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("OwnerPayoutsPanel", () => {
  it("renders the tiles, statement totals and rows from the view", async () => {
    installFetch();
    render(<OwnerPayoutsPanel />);
    expect(await screen.findByText("Available to withdraw")).toBeTruthy();
    expect(screen.getByText("$2,500")).toBeTruthy();
    expect(screen.getByText("$2,400")).toBeTruthy();
    expect(screen.getByText("$300")).toBeTruthy();
    expect(screen.getByText("5 of 6")).toBeTruthy();
    expect(screen.getByText("October 2026")).toBeTruthy();
    expect(screen.getByText("Net to you")).toBeTruthy();
    expect(screen.getByText("Balance at the end of the month")).toBeTruthy();
    expect(screen.getByText("Beginning balance")).toBeTruthy();
    expect(screen.getByText("12 Maple St")).toBeTruthy();
    expect(screen.getByText("Leaky tap · Pipes Co")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Leaky tap · Pipes Co" })).toBeTruthy();
    // The ledger's own link is never followed: a service line opens the house in the Property portal.
    expect(document.body.innerHTML).not.toContain("/portal/services/abc");
    expect(screen.getByText("Completed")).toBeTruthy();
  });

  it("hides the occupancy tile when there is none and the approvals section when the list is empty", async () => {
    currentView = view({ occupancy: null, pendingApprovals: [] });
    installFetch();
    render(<OwnerPayoutsPanel />);
    expect(await screen.findByText("Available to withdraw")).toBeTruthy();
    expect(screen.queryByText("Rooms occupied")).toBeNull();
    expect(screen.queryByText("Repair approvals")).toBeNull();
    expect(document.querySelector('[data-attr="owner-finances-approvals"]')).toBeNull();
  });

  it("posts the withdrawal with the typed cents and a fresh client key, then reloads", async () => {
    installFetch();
    writeResponses["POST /api/owner/finances/withdraw"] = json(200, { ok: true, withdrawalId: "w9", payoutPending: true });
    render(<OwnerPayoutsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw" }));
    const amount = (await screen.findByDisplayValue("2400.00")) as HTMLInputElement;
    fireEvent.change(amount, { target: { value: "$1,250.50" } });
    const loadsBefore = calls.filter((c) => c.method === "GET").length;
    fireEvent.click(screen.getAllByRole("button", { name: "Withdraw" }).at(-1)!);
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("/api/owner/finances/withdraw");
    expect(post.body).toEqual({ workspaceId: "ws-1", amountCents: 125_050, clientKey: "key-1" });
    expect(await screen.findByText("Your bank payout is being set up")).toBeTruthy();
    await waitFor(() => expect(calls.filter((c) => c.method === "GET").length).toBeGreaterThan(loadsBefore));
  });

  it("shows the server's words and a payouts link when payouts are not ready", async () => {
    installFetch();
    writeResponses["POST /api/owner/finances/withdraw"] = json(409, { error: "Finish your payout setup first.", code: "PAYOUTS_NOT_READY" });
    render(<OwnerPayoutsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Withdraw" }));
    await screen.findByDisplayValue("2400.00");
    const submit = screen.getAllByRole("button", { name: "Withdraw" }).at(-1)!;
    fireEvent.click(submit);
    expect(await screen.findByText(/Finish your payout setup first\./)).toBeTruthy();
    const link = screen.getByRole("link", { name: "Set up payouts" }) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/portal/payments/payouts");
  });

  it("posts approve and decline for a repair", async () => {
    installFetch();
    render(<OwnerPayoutsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve Roof patch" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")).toMatchObject({ url: "/api/owner/finances/expenses/exp-1", body: { approve: true } });
    fireEvent.click(screen.getByRole("button", { name: "Decline Roof patch" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(2));
    expect(calls.filter((c) => c.method === "POST")[1]).toMatchObject({ url: "/api/owner/finances/expenses/exp-1", body: { approve: false } });
  });

  it("approves routine repairs up to the typed cap", async () => {
    installFetch();
    writeResponses["POST /api/owner/finances/expenses/approve-routine"] = json(200, { approved: 1 });
    render(<OwnerPayoutsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve routine repairs" }));
    const cap = (await screen.findByDisplayValue("250.00")) as HTMLInputElement;
    fireEvent.change(cap, { target: { value: "500" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Approve" }).at(-1)!);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/approve-routine"))).toBe(true));
    expect(calls.find((c) => c.url.endsWith("/approve-routine"))).toMatchObject({ method: "POST", body: { workspaceId: "ws-1", capCents: 50_000 } });
  });

  it("saves settings as integer cents through the policy route", async () => {
    installFetch();
    render(<OwnerPayoutsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    fireEvent.change(await screen.findByDisplayValue("250.00"), { target: { value: "300" } });
    fireEvent.change(screen.getByDisplayValue("100.00"), { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")).toMatchObject({
      url: "/api/owner/finances/policy/pol-1",
      body: { repairApprovalThresholdCents: 30_000, reserveTargetCents: 0 },
    });
  });

  it("shows a waiting agreement and signs it", async () => {
    search = "review=pol-9";
    installFetch({
      workspaces: [{ id: "ws-1", name: "Maple Court", status: "active", feeLine: "x" }],
      waiting: [{ id: "pol-9", workspaceId: "ws-2", feeLine: "You receive 90%, PropLane keeps 10% of rent", terms: TERMS, effectiveFrom: "2026-10-18" }],
    });
    render(<OwnerPayoutsPanel />);
    expect(await screen.findByText("You receive 90%, PropLane keeps 10% of rent")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sign" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")?.url).toBe("/api/owner/finances/policy/pol-9/sign");
  });

  it("moves between months through the chevrons", async () => {
    installFetch();
    render(<OwnerPayoutsPanel />);
    fireEvent.click(await screen.findByRole("button", { name: "Previous month" }));
    await waitFor(() => expect(calls.some((c) => c.url.includes("month=2026-09"))).toBe(true));
  });

  it("opens the confirm pop-up for an ?approve= link", async () => {
    search = "workspace=ws-1&approve=exp-1";
    installFetch();
    render(<OwnerPayoutsPanel />);
    expect(await screen.findByRole("button", { name: "Decline" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    expect(calls.find((c) => c.method === "POST")).toMatchObject({ url: "/api/owner/finances/expenses/exp-1", body: { approve: true } });
  });

  it("says so when there is nothing managed, and offers a retry on an error", async () => {
    installFetch({ workspaces: [], waiting: [] });
    render(<OwnerPayoutsPanel />);
    expect(await screen.findByText("No managed workspaces yet")).toBeTruthy();
    cleanup();
    invalidateSharedGets();
    vi.stubGlobal("fetch", vi.fn(async () => json(500, { error: "boom" })));
    render(<OwnerPayoutsPanel />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

describe("shiftMonthKey", () => {
  it("crosses year boundaries", () => {
    expect(shiftMonthKey("2026-01", -1)).toBe("2025-12");
    expect(shiftMonthKey("2026-12", 1)).toBe("2027-01");
    expect(shiftMonthKey("2026-10", 0)).toBe("2026-10");
  });
});

describe("useOwnerPayoutsAllowed (the tab gate)", () => {
  function Probe() {
    return <span data-attr="probe">{useOwnerPayoutsAllowed() ? "shown" : "hidden"}</span>;
  }

  it("shows the Owner payouts tab for the owner of record of a managed workspace", async () => {
    installFetch();
    render(<Probe />);
    await waitFor(() => expect(screen.getByText("shown")).toBeTruthy());
  });

  it("hides it on a 403, so an ordinary manager never sees the tab", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(403, { error: "Forbidden." })));
    render(<Probe />);
    await waitFor(() => expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0));
    expect(screen.getByText("hidden")).toBeTruthy();
  });
});
