// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ServiceSourcingCard } from "@/components/portal/service-sourcing-card";
afterEach(() => vi.unstubAllGlobals());
it("keeps Pause available for a collected quote and resumes without creating a booking", async () => {
  let state = "quote_collected";
  const actions: string[] = [];
  vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") { const action = JSON.parse(String(init.body)).action; actions.push(action); state = action === "pause" ? "paused" : "quote_collected"; }
    return new Response(JSON.stringify({ job: { state, stage: "Your vendors", reason: null }, candidates: [] }), { status: 200 });
  }));
  render(<ServiceSourcingCard workOrderId="service" />);
  fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
  fireEvent.click(await screen.findByRole("button", { name: "Resume" }));
  await waitFor(() => expect(actions).toEqual(["pause", "resume"]));
  await screen.findByRole("button", { name: "Pause" });
});
