// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PortalWorkspace } from "@/lib/workspaces/types";

const showToast = vi.fn();
const confirm = vi.fn().mockResolvedValue(true);
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast }), useConfirm: () => confirm }));
vi.mock("@/components/portal/portal-read-only-context", () => ({ usePortalReadOnly: () => false }));

import { ServiceTeamSection } from "@/components/portal/service-team-section";

const workspace = {
  id: "ws-1",
  name: "Ambika",
  ownerUserId: "owner",
  owned: false,
  isDefault: false,
  isService: true,
  propertyIds: [],
  propertyPermissions: {},
  members: [
    { linkId: "l1", userId: "u1", name: "Prakrit", email: "p@x.com", role: "admin", houseScope: "all", propertyIds: [], modules: [], status: "accepted", joinedAt: null, legacyRights: false },
    { linkId: "l2", userId: "u2", name: "Maya", email: "", role: "admin", houseScope: "all", propertyIds: [], modules: [], status: "pending", joinedAt: null, legacyRights: false },
  ],
} as unknown as PortalWorkspace;

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  showToast.mockClear();
  confirm.mockClear();
});

describe("ServiceTeamSection", () => {
  it("lists the team with pending invites marked, and offers invite and remove to an admin", () => {
    render(<ServiceTeamSection workspace={workspace} isAdmin onChanged={vi.fn()} />);
    expect(screen.getByText("Prakrit")).toBeTruthy();
    expect(screen.getByText("Invited")).toBeTruthy();
    expect(screen.getByPlaceholderText("Email or PropLane ID")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Remove / })).toHaveLength(2);
  });

  it("is read-only for a helper: the team, no invite box, no remove", () => {
    render(<ServiceTeamSection workspace={workspace} isAdmin={false} onChanged={vi.fn()} />);
    expect(screen.getByText("Prakrit")).toBeTruthy();
    expect(screen.queryByPlaceholderText("Email or PropLane ID")).toBeNull();
    expect(screen.queryAllByRole("button", { name: /^Remove / })).toHaveLength(0);
  });

  it("invites by email through the admin route, with no plan check, then refreshes", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn();
    render(<ServiceTeamSection workspace={workspace} isAdmin onChanged={onChanged} />);
    const invite = screen.getByRole("button", { name: "Invite" }) as HTMLButtonElement;
    expect(invite.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText("Email or PropLane ID"), { target: { value: "helper@example.com" } });
    fireEvent.click(invite);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]![0]).toBe("/api/admin/service-workspaces");
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({ action: "team-invite", id: "ws-1", email: "helper@example.com" });
    expect(showToast).toHaveBeenCalledWith("Invite sent.");
  });

  it("a PropLane ID is sent as one, and the server's refusal is shown", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "No account found with this PropLane ID." }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<ServiceTeamSection workspace={workspace} isAdmin onChanged={vi.fn()} />);
    fireEvent.change(screen.getByPlaceholderText("Email or PropLane ID"), { target: { value: "AX-0000" } });
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("No account found with this PropLane ID."));
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({ action: "team-invite", id: "ws-1", proplaneId: "AX-0000" });
  });

  it("removes a teammate after a confirm", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    vi.stubGlobal("fetch", fetchMock);
    const onChanged = vi.fn();
    render(<ServiceTeamSection workspace={workspace} isAdmin onChanged={onChanged} />);
    fireEvent.click(screen.getByRole("button", { name: "Remove Maya" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(confirm).toHaveBeenCalled();
    expect(JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body))).toEqual({ action: "team-remove", id: "ws-1", linkId: "l2" });
  });
});
