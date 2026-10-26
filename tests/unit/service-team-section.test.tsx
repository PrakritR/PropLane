// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { PortalWorkspace } from "@/lib/workspaces/types";
import type { ServiceTeamMember } from "@/lib/service/service-team-types";

const showToast = vi.fn();
const confirm = vi.fn().mockResolvedValue(true);
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast }), useConfirm: () => confirm }));
vi.mock("@/components/portal/portal-read-only-context", () => ({ usePortalReadOnly: () => false }));

import { ServiceTeamSection, serviceTeamRoleLabel } from "@/components/portal/service-team-section";

const workspace = {
  id: "ws-1",
  name: "Ambika",
  ownerUserId: "owner",
  owned: false,
  isDefault: false,
  isService: true,
  propertyIds: ["h1", "h2"],
  propertyLabels: { h1: "5257 Brooklyn Ave", h2: "5259 Brooklyn Ave" },
  propertyPermissions: {},
  members: [],
} as unknown as PortalWorkspace;

/** What the workspace CONTEXT carries: what a helper (and a failed admin read) draws. */
const helperWorkspace = {
  ...workspace,
  members: [{ linkId: "l1", userId: "u1", name: "Prakrit", email: "p@x.com", role: "admin", status: "accepted" }],
} as unknown as PortalWorkspace;

const TEAM: ServiceTeamMember[] = [
  { linkId: "l1", userId: "u1", name: "Prakrit", email: "p@x.com", role: "admin", status: "accepted", ownerOfRecord: false, delivery: "account", houseScope: "all", assignedPropertyIds: ["h1", "h2"] },
  { linkId: "l2", userId: "u2", name: "Maya", email: "", role: "property_manager", status: "pending", ownerOfRecord: false, delivery: "account", houseScope: "selected", assignedPropertyIds: ["h1"] },
  { linkId: "l3", userId: "u3", name: "Ambika Rao", email: "a@x.com", role: "property_owner", status: "accepted", ownerOfRecord: true, delivery: "account", houseScope: "selected", assignedPropertyIds: ["h1", "h2"] },
  { linkId: "il-1", userId: "", name: "new@x.com", email: "new@x.com", role: "property_owner", status: "pending", ownerOfRecord: true, delivery: "link" },
];

/** A fetch that answers the `team` read with TEAM and every write with ok. */
function stubFetch(extra?: (body: Record<string, unknown>) => Record<string, unknown> | undefined) {
  const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const custom = extra?.(body);
    if (custom) return { ok: (custom.ok as boolean | undefined) ?? true, json: async () => custom };
    return { ok: true, json: async () => (body.action === "team" ? { members: TEAM, candidates: [], canManage: true } : { ok: true }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}
const writes = (fetchMock: ReturnType<typeof stubFetch>) =>
  fetchMock.mock.calls.map((c) => JSON.parse(String((c[1] as RequestInit).body)) as Record<string, unknown>).filter((b) => b.action !== "team");

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  showToast.mockClear();
  confirm.mockClear();
});

describe("serviceTeamRoleLabel", () => {
  it("names the owner 'Owner' and a pending seat 'Invited · <role>'", () => {
    expect(serviceTeamRoleLabel({ role: "property_owner", status: "accepted", ownerOfRecord: true })).toBe("Owner");
    expect(serviceTeamRoleLabel({ role: "property_owner", status: "pending", ownerOfRecord: true })).toBe("Invited · Owner");
    expect(serviceTeamRoleLabel({ role: "property_manager", status: "pending", ownerOfRecord: false })).toBe("Invited · Property manager");
    expect(serviceTeamRoleLabel({ role: "full", status: "accepted", ownerOfRecord: false })).toBe("Admin");
  });
});

describe("ServiceTeamSection", () => {
  it("lists the team with Owner and 'Invited · Owner' rows, a round + to invite and a ⋯ per row for an admin", async () => {
    stubFetch();
    render(<ServiceTeamSection workspace={workspace} isAdmin onChanged={vi.fn()} />);
    expect(await screen.findByText("Ambika Rao")).toBeTruthy();
    expect(screen.getByText("Prakrit")).toBeTruthy();
    expect(screen.getByText("Admin · All houses")).toBeTruthy();
    expect(screen.getByText("Invited · Property manager")).toBeTruthy();
    expect(screen.getByText("Owner")).toBeTruthy();
    expect(screen.getByText("Invited · Owner")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Invite" })).toBeTruthy();
    expect(screen.getAllByRole("button", { name: /^Actions for / })).toHaveLength(4);
    // The old one-box Invite row is gone.
    expect(screen.queryByPlaceholderText("Email or PropLane ID")).toBeNull();
  });

  it("is read-only for a helper: the context's team (the roster route is admin-only), no +, no ⋯", async () => {
    const fetchMock = stubFetch();
    render(<ServiceTeamSection workspace={helperWorkspace} isAdmin={false} onChanged={vi.fn()} />);
    expect(await screen.findByText("Prakrit")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Invite" })).toBeNull();
    expect(screen.queryAllByRole("button", { name: /^Actions for / })).toHaveLength(0);
    // The admin-only route is never called for them, so a 403 can never blank the list.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the context's roster when the admin roster read fails, instead of showing an empty team", async () => {
    stubFetch((body) => (body.action === "team" ? { ok: false, error: "Nope." } : undefined));
    render(<ServiceTeamSection workspace={helperWorkspace} isAdmin onChanged={vi.fn()} />);
    expect(await screen.findByText("Prakrit")).toBeTruthy();
  });

  it("the + opens the Invite sheet: email or PropLane ID, Role with Owner, Houses, and per-module levels", async () => {
    stubFetch();
    render(<ServiceTeamSection workspace={workspace} isAdmin onChanged={vi.fn()} />);
    await screen.findByText("Prakrit");
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));
    expect(await screen.findByPlaceholderText("Email or PropLane ID")).toBeTruthy();
    expect(document.querySelector('[data-attr="service-invite-role"]')).toBeTruthy();
    expect(document.querySelector('[data-attr="service-invite-houses"]')).toBeTruthy();
    // Send is off until someone is named.
    expect((screen.getByRole("button", { name: "Send invite" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("sends the invite through the admin route with the sheet's choice, then refreshes", async () => {
    const fetchMock = stubFetch();
    const onChanged = vi.fn();
    render(<ServiceTeamSection workspace={workspace} isAdmin onChanged={onChanged} />);
    await screen.findByText("Prakrit");
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));
    fireEvent.change(await screen.findByPlaceholderText("Email or PropLane ID"), { target: { value: "helper@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const [sent] = writes(fetchMock);
    expect(sent).toMatchObject({ action: "team-invite", id: "ws-1", email: "helper@example.com", teamRole: "viewer", houseScope: "all" });
    expect(sent!.assignedPropertyIds).toEqual(["h1", "h2"]);
    expect(showToast).toHaveBeenCalledWith("Invite sent.");
  });

  it("shows the server's refusal inside the sheet and keeps it open", async () => {
    stubFetch((body) => (body.action === "team-invite" ? { ok: false, error: "No account found with this PropLane ID." } : undefined));
    render(<ServiceTeamSection workspace={workspace} isAdmin onChanged={vi.fn()} />);
    await screen.findByText("Prakrit");
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));
    fireEvent.change(await screen.findByPlaceholderText("Email or PropLane ID"), { target: { value: "AX-0000" } });
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("No account found with this PropLane ID."));
  });

  it("a second Owner asks to replace first, and only a confirmed replace sends replaceOwner", async () => {
    const fetchMock = stubFetch((body) =>
      body.action === "team-invite" && body.replaceOwner !== true
        ? { ok: false, error: "Ambika Rao is the owner now. Replace them?", code: "owner_exists", ownerName: "Ambika Rao" }
        : undefined,
    );
    render(<ServiceTeamSection workspace={workspace} isAdmin onChanged={vi.fn()} />);
    await screen.findByText("Prakrit");
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));
    fireEvent.change(await screen.findByPlaceholderText("Email or PropLane ID"), { target: { value: "owner@example.com" } });
    // Role -> Owner.
    const roleTrigger = document.querySelector('[data-attr="service-invite-role"]') as HTMLElement;
    expect(roleTrigger).toBeTruthy();
    fireEvent.click(roleTrigger);
    fireEvent.click(await screen.findByRole("option", { name: "Owner" }));
    // Owner has no houses to pick.
    expect(document.querySelector('[data-attr="service-invite-houses"]')).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ title: "Replace the owner?", description: expect.stringContaining("Ambika Rao") })));
    await waitFor(() => expect(writes(fetchMock)).toHaveLength(2));
    const [first, second] = writes(fetchMock);
    expect(first).toMatchObject({ action: "team-invite", ownerOfRecord: true });
    expect(first).not.toHaveProperty("replaceOwner");
    expect(second).toMatchObject({ action: "team-invite", ownerOfRecord: true, replaceOwner: true });
  });

  it("declining the replace sends nothing more", async () => {
    confirm.mockResolvedValueOnce(false);
    const fetchMock = stubFetch((body) =>
      body.action === "team-invite" ? { ok: false, error: "x", code: "owner_exists", ownerName: "Ambika Rao" } : undefined,
    );
    render(<ServiceTeamSection workspace={workspace} isAdmin onChanged={vi.fn()} />);
    await screen.findByText("Prakrit");
    fireEvent.click(screen.getByRole("button", { name: "Invite" }));
    fireEvent.change(await screen.findByPlaceholderText("Email or PropLane ID"), { target: { value: "owner@example.com" } });
    fireEvent.click(document.querySelector('[data-attr="service-invite-role"]') as HTMLElement);
    fireEvent.click(await screen.findByRole("option", { name: "Owner" }));
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(writes(fetchMock)).toHaveLength(1);
  });

  it("⋯ offers Edit access on a teammate (not on the owner or an unaccepted link) and Remove on every row", async () => {
    stubFetch();
    render(<ServiceTeamSection workspace={workspace} isAdmin onChanged={vi.fn()} />);
    await screen.findByText("Prakrit");
    fireEvent.keyDown(screen.getByRole("button", { name: "Actions for Prakrit" }), { key: "Enter" });
    expect(await screen.findByRole("menuitem", { name: "Edit access" })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Remove" })).toBeTruthy();
    cleanup();
    stubFetch();
    render(<ServiceTeamSection workspace={workspace} isAdmin onChanged={vi.fn()} />);
    await screen.findByText("Ambika Rao");
    fireEvent.keyDown(screen.getByRole("button", { name: "Actions for Ambika Rao" }), { key: "Enter" });
    await screen.findByRole("menuitem", { name: "Remove" });
    expect(screen.queryByRole("menuitem", { name: "Edit access" })).toBeNull();
  });

  it("Edit access opens the same sheet prefilled from the seat and saves through team-access", async () => {
    const fetchMock = stubFetch();
    const onChanged = vi.fn();
    render(<ServiceTeamSection workspace={workspace} isAdmin onChanged={onChanged} />);
    await screen.findByText("Prakrit");
    fireEvent.keyDown(screen.getByRole("button", { name: "Actions for Maya" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Edit access" }));
    // Prefilled and read-only recipient; the seat's own role and houses.
    const recipient = (await screen.findByPlaceholderText("Email or PropLane ID")) as HTMLInputElement;
    expect(recipient.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save access" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const [saved] = writes(fetchMock);
    expect(saved).toMatchObject({ action: "team-access", id: "ws-1", linkId: "l2", teamRole: "property_manager", houseScope: "selected", assignedPropertyIds: ["h1"] });
    expect(showToast).toHaveBeenCalledWith("Access saved.");
  });

  it("removes a teammate after a confirm, and a link invite by its invite link id", async () => {
    const fetchMock = stubFetch();
    render(<ServiceTeamSection workspace={workspace} isAdmin onChanged={vi.fn()} />);
    await screen.findByText("Prakrit");
    fireEvent.keyDown(screen.getByRole("button", { name: "Actions for Maya" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));
    await waitFor(() => expect(writes(fetchMock)).toHaveLength(1));
    expect(confirm).toHaveBeenCalled();
    expect(writes(fetchMock)[0]).toEqual({ action: "team-remove", id: "ws-1", linkId: "l2" });
    fireEvent.keyDown(screen.getByRole("button", { name: "Actions for new@x.com" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Remove" }));
    await waitFor(() => expect(writes(fetchMock)).toHaveLength(2));
    expect(writes(fetchMock)[1]).toEqual({ action: "team-remove", id: "ws-1", inviteLinkId: "il-1" });
  });
});
