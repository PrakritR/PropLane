// @vitest-environment jsdom
/** The Managers row action "Managed by PropLane...": between Copy PropLane ID and Disable, and hidden for an account with no unmanaged workspace. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
  usePathname: () => "/admin/axis-users",
}));
vi.mock("@/lib/portal-nav-client", () => ({ usePortalNavigate: () => () => {} }));
vi.mock("@/components/providers/app-ui-provider", () => ({
  useAppUi: () => ({ showToast: vi.fn() }),
  useConfirm: () => vi.fn(async () => true),
}));
vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: () => false, DEMO_MANAGER_USER_ID: "demo-manager" }));
vi.mock("@/components/portal/managed-by-proplane-sheet", () => ({
  ManagedByProplaneSheet: ({ account }: { account: { id: string; name: string } }) => <div data-testid="managed-sheet">{account.id}:{account.name}</div>,
}));

const row = (id: string, name: string, unmanaged: number) => ({
  id,
  kind: "manager",
  email: `${name.toLowerCase()}@example.com`,
  fullName: name,
  managerId: `AX-${id}`,
  active: true,
  joinedAt: "2026-01-01T00:00:00.000Z",
  lastSignInAt: null,
  lastSignInKnown: true,
  workspaceCount: 2,
  unmanagedWorkspaceCount: unmanaged,
});

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/api/admin/accounts/search")) {
        return {
          ok: true,
          json: async () => ({
            rows: [row("u1", "Marc", 2), row("u2", "Priya", 0)],
            counts: { manager: 2, resident: 0, vendor: 0 },
            countsComplete: true,
            activeCounts: { manager: 2, resident: 0, vendor: 0 },
          }),
        } as Response;
      }
      return { ok: true, json: async () => ({ rows: [], rules: [] }) } as Response;
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

import { AdminAxisUsersClient } from "@/components/portal/admin-axis-users-client";

async function openMenu(name: string) {
  fireEvent.keyDown(await screen.findByRole("button", { name: `Actions for ${name}` }), { key: "Enter" });
  await screen.findByRole("menuitem", { name: "Open" });
  return screen.getAllByRole("menuitem").map((item) => item.textContent?.trim());
}

describe("Accounts > Managers > Managed by PropLane...", () => {
  it("appears between Copy PropLane ID and Disable for a manager with an unmanaged workspace, and opens the sheet for that account", async () => {
    render(<AdminAxisUsersClient />);
    const labels = await openMenu("Marc");
    expect(labels).toEqual(["View", "Open", "Copy PropLane ID", "Managed by PropLane…", "Disable", "Delete"]);
    fireEvent.click(screen.getByRole("menuitem", { name: "Managed by PropLane…" }));
    await waitFor(() => expect(screen.getByTestId("managed-sheet").textContent).toBe("u1:Marc"));
  });

  it("is hidden when every workspace the account owns is already managed (or archived)", async () => {
    render(<AdminAxisUsersClient />);
    const labels = await openMenu("Priya");
    expect(labels).toEqual(["View", "Open", "Copy PropLane ID", "Disable", "Delete"]);
  });
});
