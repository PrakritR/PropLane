// @vitest-environment jsdom
/**
 * New workspace (admin +): the free-text "Owner of record" is replaced by an Owner heading with a Name and an Email or
 * PropLane ID, both optional. Create posts both; a filled-in contact sends the owner invite (server side).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const showToast = vi.fn();
vi.mock("@/components/providers/app-ui-provider", () => ({ useAppUi: () => ({ showToast }) }));
// The pop-up frame is the shared AddWorkspace; only its children, side panel and Create button matter here.
vi.mock("@/components/portal/add-workspace", () => ({
  AddWorkspace: (props: { children: React.ReactNode; sidePanel: React.ReactNode; onFinish: () => void; lastLabel: string; lastDisabled: boolean }) => (
    <div>
      {props.children}
      <aside data-testid="preview">{props.sidePanel}</aside>
      <button type="button" disabled={props.lastDisabled} onClick={props.onFinish}>
        {props.lastLabel}
      </button>
    </div>
  ),
}));

import { AdminNewServiceWorkspace } from "@/components/portal/admin-new-service-workspace";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  showToast.mockClear();
});

describe("AdminNewServiceWorkspace", () => {
  it("asks for Name and City, then an Owner heading with Name and Email or PropLane ID; no 'Owner of record' text box", () => {
    render(<AdminNewServiceWorkspace open onClose={vi.fn()} onCreated={vi.fn()} />);
    expect(screen.getByRole("heading", { name: "Owner" })).toBeTruthy();
    expect(document.querySelector('[data-attr="admin-service-workspace-client"]')).toBeTruthy();
    expect(screen.getByPlaceholderText("owner@email.com")).toBeTruthy();
    expect(screen.queryByText("Owner of record")).toBeNull();
  });

  it("the preview shows the owner's name", () => {
    render(<AdminNewServiceWorkspace open onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(document.querySelector('[data-attr="admin-service-workspace-client"]') as HTMLInputElement, { target: { value: "Ambika Rao" } });
    expect(screen.getByTestId("preview").textContent).toContain("Ambika Rao");
  });

  it("creates with the owner's name and email, and says the invite went", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ id: "ws-9", ownerInvite: { sent: true } }) }));
    vi.stubGlobal("fetch", fetchMock);
    const onCreated = vi.fn();
    render(<AdminNewServiceWorkspace open onClose={vi.fn()} onCreated={onCreated} />);
    fireEvent.change(document.querySelector('[data-attr="admin-service-workspace-name"]') as HTMLInputElement, { target: { value: "PropLane Seattle" } });
    fireEvent.change(document.querySelector('[data-attr="admin-service-workspace-client"]') as HTMLInputElement, { target: { value: "Ambika Rao" } });
    fireEvent.change(screen.getByPlaceholderText("owner@email.com"), { target: { value: "ambika@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith("ws-9", "PropLane Seattle"));
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).toEqual({ action: "create", name: "PropLane Seattle", city: null, ownerOfRecord: "Ambika Rao", ownerContact: "ambika@example.com" });
    expect(showToast).toHaveBeenCalledWith("Workspace created. Invite sent to the owner.");
  });

  it("both owner fields are optional: a blank email posts no contact and no invite toast", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ id: "ws-9", ownerInvite: null }) }));
    vi.stubGlobal("fetch", fetchMock);
    const onCreated = vi.fn();
    render(<AdminNewServiceWorkspace open onClose={vi.fn()} onCreated={onCreated} />);
    fireEvent.change(document.querySelector('[data-attr="admin-service-workspace-name"]') as HTMLInputElement, { target: { value: "PropLane Seattle" } });
    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    const body = JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body));
    expect(body).not.toHaveProperty("ownerContact");
    expect(showToast).not.toHaveBeenCalled();
  });

  it("blocks Create on a malformed email, and tells the operator when the workspace was made but the invite failed", async () => {
    render(<AdminNewServiceWorkspace open onClose={vi.fn()} onCreated={vi.fn()} />);
    fireEvent.change(document.querySelector('[data-attr="admin-service-workspace-name"]') as HTMLInputElement, { target: { value: "PropLane Seattle" } });
    fireEvent.change(screen.getByPlaceholderText("owner@email.com"), { target: { value: "not@valid" } });
    expect((screen.getByRole("button", { name: "Create workspace" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => ({ id: "ws-9", ownerInvite: { sent: false, error: "No account found with this PropLane ID." } }) })),
    );
    const onCreated = vi.fn();
    render(<AdminNewServiceWorkspace open onClose={vi.fn()} onCreated={onCreated} />);
    fireEvent.change(document.querySelector('[data-attr="admin-service-workspace-name"]') as HTMLInputElement, { target: { value: "PropLane Seattle" } });
    fireEvent.change(screen.getByPlaceholderText("owner@email.com"), { target: { value: "AX-0000" } });
    fireEvent.click(screen.getByRole("button", { name: "Create workspace" }));
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(showToast).toHaveBeenCalledWith("Workspace created. The owner invite did not send: No account found with this PropLane ID.");
  });
});
