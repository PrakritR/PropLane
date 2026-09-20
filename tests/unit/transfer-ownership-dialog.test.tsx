// @vitest-environment jsdom
/**
 * Transfer ownership: submit stays gated on typing the workspace name, a
 * "Nothing" role afterwards sends an empty grant, and a multi-house transfer
 * goes out one house at a time in order and stops at the first failure
 * rather than pressing on or rolling back what already moved.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { PortalWorkspace, WorkspaceMember } from "@/lib/workspaces/types";

const showToast = vi.fn();

vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast }),
}));

import { TransferOwnershipDialog } from "@/components/portal/transfer-ownership-dialog";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  showToast.mockClear();
});

const workspace: PortalWorkspace = {
  id: "ws-1",
  name: "Acme Portfolio",
  ownerUserId: "owner-1",
  owned: true,
  isDefault: false,
  propertyIds: ["prop-a", "prop-b"],
  propertyLabels: { "prop-a": "House A", "prop-b": "House B" },
  propertyPermissions: {},
};

const member: WorkspaceMember = {
  linkId: "link-1",
  userId: "user-2",
  name: "Jordan Lee",
  email: "jordan@example.com",
  role: "viewer",
  houseScope: "all",
  propertyIds: ["prop-a", "prop-b"],
  modules: [],
  status: "accepted",
  joinedAt: null,
  legacyRights: false,
};

function renderDialog(onDone: () => void = () => {}) {
  return render(
    <TransferOwnershipDialog open onClose={() => {}} workspace={workspace} member={member} onDone={onDone} />,
  );
}

function pickOption(dataAttr: string, listboxLabel: string, optionName: string) {
  const trigger = document.querySelector(`[data-attr="${dataAttr}"]`);
  if (!trigger) throw new Error(`No trigger for ${dataAttr}`);
  fireEvent.click(trigger);
  const listbox = screen.getByRole("listbox", { name: listboxLabel });
  const option = within(listbox).getByRole("option", { name: optionName });
  fireEvent.pointerDown(option, { pointerId: 1, clientX: 10, clientY: 10 });
  fireEvent.pointerUp(option, { pointerId: 1, clientX: 10, clientY: 10 });
}

function typeConfirm(value: string) {
  const input = document.querySelector('[data-attr="transfer-confirm"]') as HTMLInputElement;
  fireEvent.change(input, { target: { value } });
}

function submitButton() {
  return screen.getByRole("button", { name: "Transfer ownership" });
}

describe("TransferOwnershipDialog", () => {
  it("keeps submit disabled until the typed value matches the workspace name", () => {
    renderDialog();
    expect(submitButton()).toBeDisabled();
    typeConfirm("acme");
    expect(submitButton()).toBeDisabled();
    typeConfirm(" Acme Portfolio ");
    expect(submitButton()).not.toBeDisabled();
  });

  it("sends an empty grant when the kept role is Nothing", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    renderDialog();

    pickOption("transfer-keep-role", "Your role afterwards", "Nothing");
    typeConfirm("Acme Portfolio");
    fireEvent.click(submitButton());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    for (const call of fetchMock.mock.calls) {
      const body = JSON.parse(String(call[1]?.body));
      expect(body.formerOwnerPermissions).toEqual({});
      expect(body.newManagerUserId).toBe("user-2");
    }
  });

  it("transfers every selected house in order", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    renderDialog();

    typeConfirm("Acme Portfolio");
    fireEvent.click(submitButton());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/api/pro/properties/prop-a/transfer-ownership");
    expect(String(fetchMock.mock.calls[1]?.[0])).toContain("/api/pro/properties/prop-b/transfer-ownership");
    expect(showToast).toHaveBeenCalledWith("2 houses transferred to Jordan Lee.");
  });

  it("stops after a failed first house and names it in the toast", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "nope" }), { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    renderDialog();

    typeConfirm("Acme Portfolio");
    fireEvent.click(submitButton());

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith("0 of 2 transferred. Not moved: House A, House B.");
  });
});
