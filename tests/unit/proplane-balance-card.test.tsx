// @vitest-environment jsdom
// The mirrored PropLane balance must never present a stale or unreadable figure as
// something the owner can act on: a read failure or malformed payload replaces the
// card with an error, a re-read hides the old amount, and flag-off renders nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { ProplaneBalanceCard } from "@/components/portal/proplane-balance-card";
import { resetSharedGets } from "@/lib/shared-get-cache";

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: vi.fn() }),
  useOptionalAppUi: () => null,
}));
vi.mock("@/lib/analytics/track-client", () => ({ track: vi.fn() }));

const OK = { enabled: true, availableCents: 12_500, pendingCents: 0, currency: "usd" };

function stubRead(respond: () => Promise<Response>) {
  const fetchMock = vi.fn(respond);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

beforeEach(() => resetSharedGets());
afterEach(() => { cleanup(); resetSharedGets(); vi.unstubAllGlobals(); });

describe("ProplaneBalanceCard", () => {
  it("shows the available balance with an enabled Withdraw", async () => {
    stubRead(async () => new Response(JSON.stringify(OK), { status: 200 }));
    render(<ProplaneBalanceCard portal="manager" />);
    expect(await screen.findByText("$125.00")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Withdraw" })).not.toBeDisabled();
  });

  it("disables Withdraw when nothing is available", async () => {
    stubRead(async () => new Response(JSON.stringify({ ...OK, availableCents: 0 }), { status: 200 }));
    render(<ProplaneBalanceCard portal="manager" />);
    await screen.findByText("$0.00");
    expect(screen.getByRole("button", { name: "Withdraw" })).toBeDisabled();
  });

  it("renders nothing while the flag is off", async () => {
    const read = stubRead(async () => new Response(JSON.stringify({ ...OK, enabled: false }), { status: 200 }));
    const { container } = render(<ProplaneBalanceCard portal="vendor" />);
    await waitFor(() => expect(read).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
  });

  it("shows a visible error and no Withdraw when the read fails", async () => {
    stubRead(async () => new Response(JSON.stringify({ error: "down" }), { status: 503 }));
    render(<ProplaneBalanceCard portal="manager" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Could not load PropLane balance.");
    expect(screen.queryByRole("button", { name: "Withdraw" })).not.toBeInTheDocument();
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
  });

  it("treats a malformed snapshot as unknown, never as a zero or stale balance", async () => {
    stubRead(async () => new Response(JSON.stringify({ enabled: true, availableCents: "12500", pendingCents: 0, currency: "usd" }), { status: 200 }));
    render(<ProplaneBalanceCard portal="manager" />);
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Withdraw" })).not.toBeInTheDocument();
  });

  it("reads the vendor route for the vendor portal", async () => {
    const read = stubRead(async () => new Response(JSON.stringify(OK), { status: 200 }));
    render(<ProplaneBalanceCard portal="vendor" />);
    await screen.findByText("$125.00");
    expect(String(read.mock.calls[0]?.[0])).toBe("/api/vendor/proplane-balance");
  });
});
