// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/admin/managed-finance",
  useSearchParams: () => new URLSearchParams(),
}));

import { AdminManagedFinancePanel, managedStateFact } from "@/components/portal/admin-managed-finance-panel";

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const TERMS = { ownerShareBps: 9000, appliesTo: "rent", leasingFeeBps: 0, minFeeCents: 0, reserveTargetCents: 0, repairApprovalThresholdCents: 25_000 };
const PLATFORM = {
  platformCashCents: 900_000,
  owedToOwnersCents: 700_000,
  owedToVendorsCents: 50_000,
  inFlightCents: 0,
  depositLiabilityCents: 0,
  disputeHoldCents: 0,
  feeRevenueCents: 70_000,
  processingRecoveryCents: 0,
  disputeExpenseCents: 0,
  revenueByMonth: [{ workspaceId: "w1", workspaceName: "Maple Court", month: "2026-10", revenueCents: 70_000 }],
  stripeAvailableCents: null,
  stripePendingCents: null,
  flags: [{ check: "drift", subject: "owner-1", day: "2026-10-17" }],
  balanced: true,
};
const POLICY = { id: "pol-1", status: "active", ownerUserId: "u1", ownerName: "Olive Owner", feeLine: "Owner 90%, PropLane 10% of rent", terms: TERMS, effectiveFrom: "2026-10-01", sentAt: "2026-10-01T00:00:00Z", signedAt: "2026-10-02T00:00:00Z", acceptedVia: "portal" };
const WORKSPACES = {
  workspaces: [
    { id: "w1", name: "Maple Court", managed: true, policy: POLICY },
    { id: "w2", name: "Fir House", managed: false, policy: null },
    { id: "w3", name: "Cedar Place", managed: false, policy: { ...POLICY, id: "pol-3", status: "draft", sentAt: null, signedAt: null } },
  ],
};

type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
function install() {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method !== "GET") return json(200, { policy: {} });
      if (url === "/api/admin/managed-finance") return json(200, PLATFORM);
      if (url === "/api/admin/managed-workspaces") return json(200, WORKSPACES);
      if (url.endsWith("/policies")) return json(200, { policies: [], people: [{ userId: "u9", name: "Pat Owner", email: "pat@example.com" }] });
      return json(404, { error: "Not found." });
    }),
  );
}
async function pick(workspace: string, item: string) {
  fireEvent.keyDown(await screen.findByRole("button", { name: `Actions for ${workspace}` }), { key: "ArrowDown" });
  const menuItem = await screen.findByRole("menuitem", { name: item });
  // A destructive item ignores a tap that lands before the menu has settled.
  await new Promise((r) => setTimeout(r, 200));
  fireEvent.click(menuItem);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("AdminManagedFinancePanel", () => {
  it("shows the platform tiles, a row per workspace with its state, fee revenue and flags", async () => {
    install();
    render(<AdminManagedFinancePanel />);
    expect(await screen.findByText("Platform cash")).toBeTruthy();
    expect(screen.getByText("$9,000")).toBeTruthy();
    expect(screen.getByText("Balanced")).toBeTruthy();
    expect(screen.getByText("Unknown")).toBeTruthy();
    expect((await screen.findAllByText("Maple Court")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Olive Owner").length).toBe(2);
    expect(screen.getByText("Not managed")).toBeTruthy();
    expect(screen.getByText("Draft")).toBeTruthy();
    expect(screen.getByText("Active")).toBeTruthy();
    expect(screen.getByText("drift")).toBeTruthy();
    expect(screen.getByText("October 2026")).toBeTruthy();
  });

  it("drafts a policy with the percent converted to basis points", async () => {
    install();
    render(<AdminManagedFinancePanel />);
    await pick("Fir House", "Set up fee policy");
    await waitFor(() => expect(calls.some((c) => c.url.endsWith("/policies"))).toBe(true));
    expect(calls.some((c) => c.url === "/api/admin/managed-workspaces/w2/policies")).toBe(true);
    const share = (await screen.findByDisplayValue("90")) as HTMLInputElement;
    fireEvent.change(share, { target: { value: "85" } });
    fireEvent.click(await screen.findByText("Choose the owner"));
    fireEvent.click(await screen.findByText("Pat Owner · pat@example.com"));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls.some((c) => c.method === "POST")).toBe(true));
    const post = calls.find((c) => c.method === "POST")!;
    expect(post.url).toBe("/api/admin/managed-workspaces/w2/policies");
    expect(post.body).toMatchObject({ ownerUserId: "u9", ownerShareBps: 8500, appliesTo: "rent", leasingFeeBps: 0, minFeeCents: 0 });
  });

  it("sends a draft for signature and needs a real note to record a signed contract", async () => {
    install();
    render(<AdminManagedFinancePanel />);
    await pick("Cedar Place", "Send for signature");
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")).toMatchObject({ url: "/api/admin/managed-policies/pol-3", body: { action: "send" } });

    await pick("Cedar Place", "Record signed contract");
    fireEvent.change(await screen.findByRole("textbox"), { target: { value: "short" } });
    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    expect(await screen.findByText("Write at least 8 characters.")).toBeTruthy();
    expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(1);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Signed paper copy on file" } });
    fireEvent.click(screen.getByRole("button", { name: "Record" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "PATCH")).toHaveLength(2));
    expect(calls.filter((c) => c.method === "PATCH")[1]).toMatchObject({ body: { action: "attest", note: "Signed paper copy on file" } });
  });

  it("warns that rent will no longer be held before ending a policy", async () => {
    install();
    render(<AdminManagedFinancePanel />);
    await pick("Maple Court", "End");
    expect(await screen.findByText(/Rent will no longer be held for the owner/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "End fee policy" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH")).toBe(true));
    expect(calls.find((c) => c.method === "PATCH")).toMatchObject({ url: "/api/admin/managed-policies/pol-1", body: { action: "end" } });
  });

  it("names each policy state with a glyph and a few words", () => {
    expect(managedStateFact(null).label).toBe("Not managed");
    expect(managedStateFact({ ...POLICY, status: "ended" } as never).label).toBe("Ended");
    expect(managedStateFact({ ...POLICY, status: "draft", sentAt: "x" } as never).label).toBe("Sent for signature");
  });
});
