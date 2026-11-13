// @vitest-environment jsdom
/**
 * The admin lead thread's header never widens past the pane: "Assign to workspace" is an icon action that opens a menu (a long
 * workspace name lives in the menu, truncated), never a pill whose width follows the chosen name. The shared thread header
 * and pane are also held to min-w-0 so a long title or URL can never push the actions off the right edge.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const { confirm, assign } = vi.hoisted(() => ({ confirm: vi.fn(async () => true), assign: vi.fn(async () => ({ ok: true as const })) }));
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast: vi.fn(), confirm }) }));
vi.mock("@/lib/admin-sms-workspaces", () => ({
  useAdminSmsWorkspaces: () => [{ id: "w1", name: "1. Ambika Mago Property Management Services LLC — Seattle Eastside" }],
  assignLeadToServiceWorkspace: assign,
  openAdminWorkspaceThread: vi.fn(),
  replyToLead: vi.fn(),
}));

import { AdminLeadThread } from "@/components/portal/admin-workspace-thread-bar";
import type { ManagerSmsResidentConversation } from "@/lib/manager-sms-messages";

const LEAD: ManagerSmsResidentConversation = {
  residentUserId: null, residentEmail: null, name: "Lead •••• 2525", phone: null, propertyLabel: null, counterpartyRole: "prospect",
  conversationKey: "lead:l1", unassignedLeadId: "l1", workspaceId: null,
  messages: [{ id: "m1", direction: "inbound", body: `see https://proplane.ai/rent/listings/mgr-5259-brooklyn-ave-copy-9-rooms-7mdlyj0h2vfg?${"a".repeat(120)}`, fromPhone: null, toPhone: "", messageSid: null, source: "work_number", createdAt: "2026-10-26T19:09:00Z" }],
};

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("AdminLeadThread header", () => {
  it("assigns through an icon action and a menu, and confirms before moving the thread", async () => {
    const onAssigned = vi.fn();
    const { container } = render(<AdminLeadThread resident={LEAD} onBack={() => {}} onAssigned={onAssigned} />);
    const header = container.querySelector('[data-attr="admin-communication-assign-header"]') as HTMLElement;
    expect(header).toBeTruthy();
    // Icon chrome: one icon button, no select pill, no workspace name drawn in the header.
    const trigger = header.querySelector('[data-slot="portal-icon-action"]') as HTMLElement;
    expect(trigger.getAttribute("aria-label")).toBe("Assign to workspace");
    expect(header.textContent).toBe("");
    expect(header.querySelector("select, [role='combobox']")).toBeNull();
    expect(header.className).toContain("shrink-0");

    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    const item = await screen.findByRole("menuitem", { name: /Ambika Mago Property Management/ });
    // The long name truncates inside the menu instead of widening anything.
    expect(item.querySelector(".truncate")).toBeTruthy();
    fireEvent.click(item);
    await waitFor(() => expect(assign).toHaveBeenCalledWith({ leadId: "l1", workspaceId: "w1" }));
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(onAssigned).toHaveBeenCalled();
  });

  it("a declined confirmation assigns nothing", async () => {
    confirm.mockResolvedValueOnce(false);
    const { container } = render(<AdminLeadThread resident={LEAD} onBack={() => {}} onAssigned={() => {}} />);
    const trigger = container.querySelector('[data-attr="admin-communication-assign-header"] [data-slot="portal-icon-action"]') as HTMLElement;
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    fireEvent.click(await screen.findByRole("menuitem", { name: /Ambika Mago Property Management/ }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(assign).not.toHaveBeenCalled();
  });

  it("the shared thread header and message text are held to the pane's width", () => {
    const { container } = render(<AdminLeadThread resident={LEAD} onBack={() => {}} onAssigned={() => {}} />);
    const headerEl = container.querySelector(".portal-inbox-thread-header") as HTMLElement;
    expect(headerEl.className).toContain("min-w-0");
    expect(headerEl.className).toContain("max-w-full");
    const text = screen.getByText(/proplane\.ai\/rent\/listings/);
    expect(text.className).toContain("break-words");
    expect(text.className).toContain("[overflow-wrap:anywhere]");
  });
});
