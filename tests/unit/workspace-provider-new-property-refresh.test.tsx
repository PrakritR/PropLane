// @vitest-environment jsdom
//
// Membership is the only test a row passes to show in a workspace, and the
// membership list was read once per page load. A home created in this session
// therefore belonged to no workspace the client knew — "Save & exit" left the
// Properties list without the draft, and the home the manager had just made
// could read as missing. The provider now re-reads the workspaces when the
// local property store announces an id no workspace holds.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

const rows: Array<{ listingId?: string; adminRefId: string }> = [];
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));
vi.mock("@/hooks/use-manager-user-id", () => ({ useManagerUserId: () => ({ userId: "mgr-1", email: null, ready: true }) }));
vi.mock("@/lib/demo/demo-session", () => ({
  resolveManagerScopeUserId: (id: string | null) => id,
  DEMO_MANAGER_USER_ID: "demo-manager",
  isDemoModeActive: () => false,
}));
vi.mock("@/lib/demo-admin-property-inventory", () => ({ managerPropertyRowsForStage: () => rows }));
vi.mock("@/lib/demo-property-pipeline", () => ({ PROPERTY_PIPELINE_EVENT: "axis-property-pipeline" }));

const payloads = [
  { workspaces: [{ id: "w1", name: "My workspace", ownerUserId: "mgr-1", owned: true, isDefault: true, propertyIds: ["p-old"], propertyPermissions: {} }], activeWorkspaceId: "w1" },
  { workspaces: [{ id: "w1", name: "My workspace", ownerUserId: "mgr-1", owned: true, isDefault: true, propertyIds: ["p-old", "p-new"], propertyPermissions: {} }], activeWorkspaceId: "w1" },
];
let fetches = 0;
vi.stubGlobal("fetch", async () => {
  const body = payloads[Math.min(fetches, payloads.length - 1)];
  fetches += 1;
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
});

import { WorkspaceProvider } from "@/components/portal/workspace-provider";
import { workspaceContainsProperty } from "@/lib/workspaces/selection";

afterEach(() => {
  cleanup();
  rows.length = 0;
  fetches = 0;
});

describe("WorkspaceProvider", () => {
  it("re-reads the workspaces when a property the client just made is in no workspace it knows", async () => {
    render(<WorkspaceProvider><div /></WorkspaceProvider>);
    await waitFor(() => expect(workspaceContainsProperty("p-old")).toBe(true));
    await new Promise((r) => setTimeout(r, 30));
    const settled = fetches;
    expect(workspaceContainsProperty("p-new")).toBe(false);

    // The local store announces a change that does not add anything new — no request.
    rows.push({ adminRefId: "p-old" });
    window.dispatchEvent(new Event("axis-property-pipeline"));
    await new Promise((r) => setTimeout(r, 30));
    expect(fetches).toBe(settled);

    // A draft the editor just saved: one request, and the home is now a member.
    rows.push({ adminRefId: "p-new" });
    window.dispatchEvent(new Event("axis-property-pipeline"));
    await waitFor(() => expect(fetches).toBe(settled + 1));
    await waitFor(() => expect(workspaceContainsProperty("p-new")).toBe(true));

    // The same id never asks twice.
    window.dispatchEvent(new Event("axis-property-pipeline"));
    await new Promise((r) => setTimeout(r, 30));
    expect(fetches).toBe(settled + 1);
  });
});
