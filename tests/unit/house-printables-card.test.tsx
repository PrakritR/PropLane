// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

const open = vi.fn();
beforeEach(() => {
  vi.stubGlobal("open", open);
});
afterEach(() => {
  cleanup();
  calls.length = 0;
  open.mockClear();
});

const ROOMS = [
  { id: "r1", name: "Room 1", floor: "Ground" },
  { id: "r2", name: "Room 2", floor: "" },
];

/**
 * studio-redesign(property-tabs): Printables are three rows of the Manager tools
 * list (tile · title · one fact · one ⋯) — no boxed card, no pills, no subtext.
 * The behaviour is unchanged: the two public printables open their print route,
 * the private welcome sheet is printed for a chosen room, and the QR link can
 * be turned off.
 */
describe("HousePrintablesCard", () => {
  it("opens the two public printables from their rows", () => {
    const { container } = render(<HousePrintablesCard propertyId="prop-1" rooms={ROOMS} />);
    fireEvent.click(container.querySelector('[data-attr="house-printables-door-card"]')!);
    expect(open).toHaveBeenLastCalledWith("/print/door-card/prop-1", "_blank", "noopener,noreferrer");
    fireEvent.click(container.querySelector('[data-attr="house-printables-rules"]')!);
    expect(open).toHaveBeenLastCalledWith("/print/house-rules/prop-1", "_blank", "noopener,noreferrer");
  });

  it("each row states who sees it as a fact, with exactly one ⋯", () => {
    const { container } = render(<HousePrintablesCard propertyId="prop-1" rooms={ROOMS} />);
    const rows = container.querySelectorAll(".portal-property-row");
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toContain("Public · no codes");
    expect(rows[2]!.textContent).toContain("Private · has codes");
    rows.forEach((row) => expect(row.querySelectorAll('button[aria-label^="Actions for"]')).toHaveLength(1));
  });

  it("the welcome sheet link carries the chosen room and resident", () => {
    const { container } = render(<HousePrintablesCard propertyId="prop-1" rooms={ROOMS} />);
    fireEvent.click(container.querySelector('[data-attr="house-printables-welcome-row"]')!);
    fireEvent.change(screen.getByLabelText("Resident name"), { target: { value: "Maya" } });
    expect(screen.getByRole("link", { name: "Open welcome sheet" }).getAttribute("href")).toBe(
      "/print/welcome/prop-1?room=r1&resident=Maya",
    );
  });

  it("the live QR link can be turned off from the ⋯", async () => {
    const { container } = render(<HousePrintablesCard propertyId="prop-1" rooms={ROOMS} />);
    await waitFor(() => expect(calls.some((c) => c.method === "GET")).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.keyDown(container.querySelector('button[aria-label="Actions for Door card"]')!, { key: "Enter" });
    const off = await screen.findByText("Turn the link off");
    await new Promise((resolve) => setTimeout(resolve, 200)); // the red action ignores clicks for its settle window
    fireEvent.click(off);
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
  });
});
