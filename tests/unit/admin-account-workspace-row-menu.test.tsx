// @vitest-environment jsdom
/**
 * Account record > Workspaces: every owned workspace row of a MANAGER has a ⋯ with "View workspace" (read-only View as,
 * only for an allowlisted operator) and "Managed by PropLane…" (hidden once the workspace is `is_service`). A menu that
 * would hold one action is that action's icon; a row with neither draws nothing. Other account kinds get no menu.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const viewState = vi.hoisted(() => ({ canView: true, open: vi.fn() }));
vi.mock("@/components/portal/admin-view-as-dialog", () => ({
  useViewWorkspace: () => ({ canView: viewState.canView, open: viewState.open, dialog: null }),
}));
vi.mock("@/components/portal/managed-by-proplane-sheet", () => ({
  ManagedByProplaneSheet: (props: { initialWorkspaceId?: string }) => <div data-testid="sheet">{props.initialWorkspaceId}</div>,
}));
vi.mock("@/components/portal/admin-manager-account-detail", () => ({ ManagerBillingCards: () => null }));

import { AccountWorkspacesSection } from "@/components/portal/admin-account-record-sections";
import type { AdminAccountDetail } from "@/lib/admin/admin-account-detail.server";

const detail = (isService: boolean[]): AdminAccountDetail =>
  ({
    id: "u-1",
    fullName: "Marc Jackson",
    email: "marc@example.com",
    roles: ["manager"],
    workspaces: {
      owned: isService.map((s, i) => ({
        id: `ws-${i}`,
        name: `Home ${i}`,
        isDefault: i === 0,
        isService: s,
        createdAt: "2026-09-01T00:00:00.000Z",
        payoutsEnabled: null,
      })),
      links: [],
    },
  }) as unknown as AdminAccountDetail;

afterEach(() => {
  cleanup();
  viewState.canView = true;
  viewState.open.mockClear();
});

describe("AccountWorkspacesSection row menu", () => {
  it("offers both items on an unmanaged workspace and opens the sheet preselected to it", async () => {
    render(<AccountWorkspacesSection detail={detail([false, false])} kind="manager" />);
    const menus = screen.getAllByRole("button", { name: /Actions for Home/ });
    expect(menus).toHaveLength(2);
    fireEvent.pointerDown(menus[1]!, { button: 0, ctrlKey: false });
    fireEvent.click(menus[1]!);
    const item = await screen.findByText("Managed by PropLane…");
    expect(await screen.findByText("View workspace")).toBeTruthy();
    fireEvent.click(item);
    expect((await screen.findByTestId("sheet")).textContent).toBe("ws-1");
  });

  it("a workspace PropLane already manages has no Managed by PropLane… (one action = its icon)", () => {
    render(<AccountWorkspacesSection detail={detail([true])} kind="manager" />);
    expect(screen.queryByRole("button", { name: /Actions for/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Managed by PropLane" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "View workspace" }));
    expect(viewState.open).toHaveBeenCalledWith("ws-0", "Home 0");
  });

  it("an operator who is not on the View-as allowlist never sees View workspace", () => {
    viewState.canView = false;
    render(<AccountWorkspacesSection detail={detail([false])} kind="manager" />);
    expect(screen.queryByRole("button", { name: "View workspace" })).toBeNull();
    expect(screen.getByRole("button", { name: "Managed by PropLane" })).toBeTruthy();
  });

  it("draws no menu when neither item applies, and none for a non-manager account", () => {
    viewState.canView = false;
    render(<AccountWorkspacesSection detail={detail([true])} kind="manager" />);
    expect(screen.queryByRole("button", { name: /Actions for|Managed by PropLane|View workspace/ })).toBeNull();
    cleanup();
    viewState.canView = true;
    render(<AccountWorkspacesSection detail={detail([false])} kind="resident" />);
    expect(screen.queryByRole("button", { name: /Actions for|Managed by PropLane|View workspace/ })).toBeNull();
  });
});
