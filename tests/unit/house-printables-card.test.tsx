// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { HousePrintablesCard } from "@/components/portal/house-printables-card";

const calls: Array<{ url: string; method: string }> = [];
vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  calls.push({ url, method: init?.method ?? "GET" });
  if (init?.method === "DELETE") return new Response(JSON.stringify({ revoked: 1 }), { status: 200 });
  return new Response(JSON.stringify({ url: "https://prop-lane.space/h/abc123", issuedAt: "2026-09-14T09:00:00Z" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});

afterEach(() => {
  cleanup();
  calls.length = 0;
});

describe("HousePrintablesCard", () => {
  it("links the two public printables and the private welcome sheet for the chosen room", async () => {
    render(
      <HousePrintablesCard
        propertyId="prop-1"
        rooms={[
          { id: "r1", name: "Room 1", floor: "Ground" },
          { id: "r2", name: "Room 2", floor: "" },
        ]}
      />,
    );
    expect(screen.getByRole("link", { name: "Door card" }).getAttribute("href")).toBe("/print/door-card/prop-1");
    expect(screen.getByRole("link", { name: "House rules poster" }).getAttribute("href")).toBe("/print/house-rules/prop-1");
    fireEvent.change(screen.getByLabelText("Resident name"), { target: { value: "Maya" } });
    expect(screen.getByRole("link", { name: "Open welcome sheet" }).getAttribute("href")).toBe(
      "/print/welcome/prop-1?room=r1&resident=Maya",
    );
    // The live QR link is shown and can be turned off.
    await waitFor(() => expect(screen.getByText("prop-lane.space/h/abc123")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "Turn the link off" }));
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    await waitFor(() => expect(screen.queryByText("prop-lane.space/h/abc123")).toBeNull());
  });
});
