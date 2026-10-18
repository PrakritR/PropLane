// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { AutomationsView } from "@/lib/automations/client";

const h = vi.hoisted(() => ({
  view: null as unknown,
  save: vi.fn(),
  decide: vi.fn(),
  preview: vi.fn(),
  announce: vi.fn(),
  escalations: vi.fn(),
  decideEsc: vi.fn(),
  navigate: vi.fn(),
}));

vi.mock("@/lib/automations/client", () => ({
  fetchAutomations: async () => h.view,
  saveAutomation: h.save,
  decideHeldRun: h.decide,
  previewAutomation: h.preview,
  sendAnnouncement: h.announce,
  fetchEscalations: h.escalations,
  decideEscalation: h.decideEsc,
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => h.navigate }));
vi.mock("@/lib/portal-base-path-client", () => ({ usePaidPortalBasePath: () => "/portal" }));
vi.mock("next/navigation", () => ({ usePathname: () => "/portal/communication/escalations", useRouter: () => ({ push: vi.fn() }), useSearchParams: () => new URLSearchParams() }));

import { AutomationsSection } from "@/components/portal/automations-settings";
import { ManagerEscalationsInbox } from "@/components/portal/manager-escalations-inbox";

const row = (over: Record<string, unknown>) => ({
  id: "welcome", label: "Welcome (lease signed or booking confirmed)", audience: "resident", engine: "automation", hasOwnText: true,
  modes: ["auto", "draft", "off"], mode: "draft", template: "Welcome, {first_name}!", isDefaultTemplate: true,
  variables: [{ id: "first_name", label: "First name" }, { id: "house", label: "House" }], ...over,
});

function view(over: Partial<AutomationsView> = {}): AutomationsView {
  return {
    canEdit: true,
    presets: [
      row({}),
      row({ id: "rent_due_day", label: "Rent due today (house group)", audience: "group", variables: [{ id: "house", label: "House" }] }),
      row({ id: "rent_due_3d", label: "Rent due (3 days before)", engine: "existing", hasOwnText: false, modes: ["auto", "off"], mode: "auto" }),
    ],
    held: [{ id: "run-1", preset: "rent_due_day", audience: "group", propertyId: "P1", body: "Friendly reminder: rent is due today.", createdAt: "2026-11-01T00:00:00Z" }],
    houses: [{ id: "P1", label: "5259 Brooklyn" }, { id: "P2", label: "4709A 8th Ave" }],
    ...over,
  } as AutomationsView;
}

beforeEach(() => {
  h.view = view();
  h.save.mockReset().mockResolvedValue({ ok: true });
  h.decide.mockReset().mockResolvedValue({ ok: true });
  h.preview.mockReset().mockResolvedValue({ ok: true, text: "Welcome, Maya!", usedRealData: true });
  h.announce.mockReset().mockResolvedValue({ ok: true, sent: 2, held: 0, off: false });
  h.escalations.mockReset();
  h.decideEsc.mockReset().mockResolvedValue(true);
  h.navigate.mockReset();
});
afterEach(cleanup);

describe("AutomationsSection", () => {
  it("draws one row per preset with a glyph for where it goes and a mode control", async () => {
    render(<AutomationsSection />);
    await screen.findByText("Welcome (lease signed or booking confirmed)");
    expect(screen.getByText("Rent due today (house group)")).toBeTruthy();
    expect(screen.getAllByRole("img", { name: "House group" }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("img", { name: "One on one" }).length).toBeGreaterThan(0);
    expect(document.querySelector('[data-attr="automation-mode-welcome"]')).toBeTruthy();
    expect(document.querySelector('[data-attr="automation-mode-rent_due_3d"]')).toBeTruthy();
  });

  it("has no subtext under a row and no pills", async () => {
    const { container } = render(<AutomationsSection />);
    await screen.findByText("Welcome (lease signed or booking confirmed)");
    expect(container.querySelectorAll('[class*="rounded-full"][class*="badge"]')).toHaveLength(0);
    expect(container.textContent).not.toMatch(/work order/i);
  });

  it("sends and dismisses a held draft with icon actions, then reloads", async () => {
    render(<AutomationsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Send Rent due today (house group)" }));
    await waitFor(() => expect(h.decide).toHaveBeenCalledWith("run-1", "send"));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss Rent due today (house group)" }));
    await waitFor(() => expect(h.decide).toHaveBeenCalledWith("run-1", "dismiss"));
  });

  it("shows a refusal from the server instead of hiding it", async () => {
    h.decide.mockResolvedValue({ ok: false, error: "This house has no group chat yet." });
    render(<AutomationsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Send Rent due today (house group)" }));
    expect((await screen.findByRole("alert")).textContent).toBe("This house has no group chat yet.");
  });

  it("locks the mode control for a teammate who is not the owner", async () => {
    h.view = view({ canEdit: false });
    render(<AutomationsSection />);
    await screen.findByText("Welcome (lease signed or booking confirmed)");
    expect(screen.queryByRole("button", { name: /Edit text/ })).toBeNull();
  });

  it("opens the announce pop-up from the megaphone and sends to all houses", async () => {
    render(<AutomationsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Announce to residents" }));
    const box = await screen.findByPlaceholderText("Water is off Tuesday 9-12.");
    fireEvent.change(box, { target: { value: "Water is off Tuesday 9-12." } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(h.announce).toHaveBeenCalledTimes(1));
    expect(h.announce.mock.calls[0]![0]).toMatchObject({ text: "Water is off Tuesday 9-12.", houseIds: "all" });
    expect(await screen.findByText("Sent to 2 houses.")).toBeTruthy();
  });

  it("shows the server's reason when an announcement is refused", async () => {
    h.announce.mockResolvedValue({ ok: false, error: "A house group text cannot name a resident. Take the name out." });
    render(<AutomationsSection />);
    fireEvent.click(await screen.findByRole("button", { name: "Announce to residents" }));
    fireEvent.change(await screen.findByPlaceholderText("Water is off Tuesday 9-12."), { target: { value: "Maya move your bike" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/cannot name a resident/);
  });
});

describe("ManagerEscalationsInbox", () => {
  const item = (over: Record<string, unknown> = {}) => ({
    id: "e1", source: "ra", role: "resident", topic: "repeated_complaints", question: "3 complaints in 30 days at this house",
    excerpt: "Loud music again", propertyId: "P1", houseLabel: "5259 Brooklyn", phoneTail: "0100", escalatedAt: "2026-11-01T10:00:00Z", resolvedAt: null, ...over,
  });

  it("lists open items with the house, the source and the excerpt, and never the full number", async () => {
    h.escalations.mockResolvedValue([item()]);
    const { container } = render(<ManagerEscalationsInbox />);
    await screen.findByText("3 complaints in 30 days at this house");
    expect(container.textContent).toContain("5259 Brooklyn");
    expect(container.textContent).toContain("House group");
    expect(container.textContent).toContain("Loud music again");
    expect(container.textContent).toContain("0100");
    expect(h.escalations).toHaveBeenCalledWith("open");
  });

  it("shows an empty card and reloads for Resolved", async () => {
    h.escalations.mockResolvedValue([]);
    render(<ManagerEscalationsInbox />);
    await screen.findByText("Nothing to follow up");
    fireEvent.click(screen.getByRole("button", { name: "Resolved" }));
    await waitFor(() => expect(h.escalations).toHaveBeenCalledWith("resolved"));
  });

  it("shows an error with a retry when the list cannot load", async () => {
    h.escalations.mockResolvedValue(null);
    render(<ManagerEscalationsInbox />);
    expect(await screen.findByText("Could not load escalations.")).toBeTruthy();
  });

  it("goes back to Communication", async () => {
    h.escalations.mockResolvedValue([]);
    render(<ManagerEscalationsInbox />);
    fireEvent.click(await screen.findByRole("button", { name: "Back to Communication" }));
    expect(h.navigate).toHaveBeenCalledWith("/portal/communication/active");
  });
});
