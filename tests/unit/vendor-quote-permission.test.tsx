// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VendorQuotePermission } from "@/components/portal/vendor-quote-permission";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("VendorQuotePermission", () => {
  it("does not grant consent on mount and records only after the explicit control", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === "POST") return new Response(JSON.stringify({ permissionGranted: true }), { status: 200 });
      return new Response(JSON.stringify({ permissionGranted: false, suppressed: false }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<VendorQuotePermission workOrderId="service-1" />);
    const allow = await screen.findByRole("button", { name: "Allow quote request texts" });
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);

    fireEvent.click(allow);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/portal/vendor-sourcing-permission", expect.objectContaining({ method: "POST" })));
    await screen.findByText("Quote texts allowed");
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST");
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ workOrderId: "service-1", enabled: true });
  });

  it("keeps the opt-in control hidden when global text suppression is active", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ permissionGranted: false, suppressed: true }), { status: 200 })));

    render(<VendorQuotePermission workOrderId="service-2" />);
    await screen.findByText("Text messages paused");
    expect(screen.queryByRole("button", { name: "Allow quote request texts" })).toBeNull();
  });
});
