// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { ApplicationPaymentReceiptCard } from "@/components/portal/application-payment-receipt-card";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("application payment receipt card", () => {
  it("hides A's receipt immediately when the selected application changes to unresolved B", async () => {
    let resolveB!: (response: Response) => void;
    const pendingB = new Promise<Response>((resolve) => { resolveB = resolve; });
    vi.stubGlobal("fetch", vi.fn((url: string) => url.includes("application-a")
      ? Promise.resolve(new Response(JSON.stringify({ receipt: {
        status: "paid", principalCents: 5000, paidAt: "2026-10-04T12:00:00Z",
      } }), { status: 200 }))
      : pendingB));

    const { rerender } = render(<ApplicationPaymentReceiptCard applicationId="application-a" />);
    await screen.findByText("Paid");
    expect(screen.getByText("Oct 4, 2026")).toBeTruthy();

    rerender(<ApplicationPaymentReceiptCard applicationId="application-b" />);
    expect(screen.getByText("Loading…")).toBeTruthy();
    expect(screen.queryByText("Paid")).toBeNull();
    expect(screen.queryByText("Oct 4, 2026")).toBeNull();

    resolveB(new Response(JSON.stringify({ receipt: { status: "not_received" } }), { status: 200 }));
    await screen.findByText("Not received");
  });

  it("shows a fetch failure as an error, never as absence", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 500 })));
    render(<ApplicationPaymentReceiptCard applicationId="application-a" />);
    await waitFor(() => expect(screen.getByText("Could not load payment")).toBeTruthy());
    expect(screen.queryByText("Not received")).toBeNull();
  });
});
