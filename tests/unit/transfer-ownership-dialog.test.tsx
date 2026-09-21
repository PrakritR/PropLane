// @vitest-environment jsdom
/**
 * Transfer ownership hands the WHOLE workspace to an accepted member — no
 * house picker any more. Submit stays gated on typing the workspace name,
 * a "Nothing" role afterwards sends an empty grant, and the dialog issues
 * exactly one request to the workspace transfer route.
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

  it("renders no house pickers", () => {
    renderDialog();
    expect(document.querySelector('[data-attr="transfer-houses"]')).toBeNull();
    expect(document.querySelector('[data-attr="transfer-selected-houses"]')).toBeNull();
    expect(screen.getByText(/all 2 houses/i)).toBeInTheDocument();
  });

  it("resets the role and confirm text on reopen for a different member", () => {
    const { rerender } = renderDialog();
    pickOption("transfer-keep-role", "Your role afterwards", "Nothing");
    typeConfirm("Acme Portfolio");
    expect(submitButton()).not.toBeDisabled();

    const otherMember: WorkspaceMember = { ...member, userId: "user-3", name: "Casey Kim" };
    rerender(
      <TransferOwnershipDialog open onClose={() => {}} workspace={workspace} member={otherMember} onDone={() => {}} />,
    );
    expect(submitButton()).toBeDisabled();
    expect(document.querySelector('[data-attr="transfer-confirm"]')).toHaveValue("");
  });

  it("sends an empty grant and leaves-entirely notice when the kept role is Nothing", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    renderDialog();

    pickOption("transfer-keep-role", "Your role afterwards", "Nothing");
    expect(screen.getByText(/You leave Acme Portfolio entirely\./)).toBeInTheDocument();
    typeConfirm("Acme Portfolio");
    fireEvent.click(submitButton());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe("/api/pro/workspaces/ws-1/transfer-ownership");
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({
      newOwnerUserId: "user-2",
      formerOwnerRole: "nothing",
      formerOwnerPermissions: {},
    });
  });

  it("sends one request with the exact body and shows the success toast", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const onDone = vi.fn();
    renderDialog(onDone);

    typeConfirm("Acme Portfolio");
    fireEvent.click(submitButton());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("/api/pro/workspaces/ws-1/transfer-ownership");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(String(init?.body));
    expect(body.newOwnerUserId).toBe("user-2");
    expect(body.formerOwnerRole).toBe("admin");
    expect(body.formerOwnerPermissions).toBeTruthy();

    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Acme Portfolio transferred to Jordan Lee."));
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it("keeps the dialog open and shows the server's error on failure", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ error: "That person isn't a member of this workspace." }), { status: 404 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const onDone = vi.fn();
    renderDialog(onDone);

    typeConfirm("Acme Portfolio");
    fireEvent.click(submitButton());

    await waitFor(() => expect(showToast).toHaveBeenCalledWith("That person isn't a member of this workspace."));
    expect(onDone).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("falls back to a generic error when the failed response carries none", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({}), { status: 500 }));
    vi.stubGlobal("fetch", fetchMock);
    renderDialog();

    typeConfirm("Acme Portfolio");
    fireEvent.click(submitButton());

    await waitFor(() => expect(showToast).toHaveBeenCalledWith("Could not transfer ownership."));
  });
});
