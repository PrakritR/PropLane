// @vitest-environment jsdom
//
// The phone Filter sheet closed itself about a second after the list appeared.
// Nothing dismissed it: `WorkspaceProvider` keyed the whole portal subtree on
// `activeWorkspaceId`, which is null until GET /api/workspaces answers, so the
// first answer changed the key and REMOUNTED everything under it. The sheet's
// open state went with it (and the lists redrew their loading skeletons),
// which is why tapping Filter within ~1s of the page becoming interactive
// opened a sheet that vanished, and why a later tap survived. A first answer
// is not a workspace switch; an actual switch still resets the subtree.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useEffect } from "react";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));
vi.mock("@/hooks/use-manager-user-id", () => ({
  useManagerUserId: () => ({ userId: "mgr-1", email: null, ready: true }),
}));
vi.mock("@/lib/demo/demo-session", () => ({
  resolveManagerScopeUserId: (id: string | null) => id,
  DEMO_MANAGER_USER_ID: "demo-manager",
  isDemoModeActive: () => false,
}));
vi.mock("@/lib/demo-admin-property-inventory", () => ({ managerPropertyRowsForStage: () => [] }));
vi.mock("@/lib/demo-property-pipeline", () => ({ PROPERTY_PIPELINE_EVENT: "axis-property-pipeline" }));
vi.mock("@/hooks/use-is-client", () => ({ useIsClient: () => true }));

import { PortalFilterSortSheet } from "@/components/portal/portal-filter-sort-sheet";
import { WorkspaceProvider, useWorkspaces } from "@/components/portal/workspace-provider";

function workspace(id: string, name: string) {
  return {
    id,
    name,
    ownerUserId: "mgr-1",
    owned: true,
    isDefault: id === "w1",
    propertyIds: [],
    propertyPermissions: {},
  };
}

function workspacePayload(activeWorkspaceId: string) {
  return {
    workspaces: [workspace("w1", "My workspace"), workspace("w2", "Second workspace")],
    activeWorkspaceId,
  };
}

/** A touch phone: the Filter opens as a bottom sheet, never the anchored popover. */
function stubPhoneMedia() {
  vi.stubGlobal(
    "matchMedia",
    (query: string) =>
      ({
        matches: query.startsWith("(max-width"),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        onchange: null,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList,
  );
}

let mounts = 0;
let refreshWorkspaces: (() => Promise<void>) | null = null;

/** Names the active workspace, and counts how often the keyed subtree was rebuilt. */
function WorkspaceProbe() {
  const ctx = useWorkspaces();
  refreshWorkspaces = ctx?.refresh ?? null;
  useEffect(() => {
    mounts += 1;
  }, []);
  return <span data-testid="active-workspace">{ctx?.active?.name ?? "none"}</span>;
}

let answerWorkspaces: ((activeWorkspaceId: string) => void) | null = null;

beforeEach(() => {
  mounts = 0;
  stubPhoneMedia();
  vi.stubGlobal(
    "fetch",
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          answerWorkspaces = (activeWorkspaceId: string) =>
            resolve(Response.json(workspacePayload(activeWorkspaceId)));
        }),
    ),
  );
});

afterEach(() => {
  cleanup();
  answerWorkspaces = null;
  refreshWorkspaces = null;
  vi.unstubAllGlobals();
});

const sheet = () => document.querySelector('[data-slot="vaul-bottom-sheet"]');

function renderPortal() {
  render(
    <WorkspaceProvider>
      <WorkspaceProbe />
      <PortalFilterSortSheet filterFieldCount={2} dataAttr="test-filter-open">
        <p>fields</p>
      </PortalFilterSortSheet>
    </WorkspaceProvider>,
  );
}

async function answer(activeWorkspaceId: string, name: string) {
  await act(async () => {
    answerWorkspaces!(activeWorkspaceId);
  });
  await waitFor(() => expect(screen.getByTestId("active-workspace").textContent).toBe(name));
}

describe("the first workspace answer does not throw the page away", () => {
  it("leaves the open phone Filter sheet open", async () => {
    renderPortal();

    // Tapped while the workspace read is still in flight — the real ~1s window.
    fireEvent.click(screen.getByRole("button", { name: /Filter/ }));
    expect(sheet()).not.toBeNull();

    await answer("w1", "My workspace");

    expect(sheet()).not.toBeNull();
    expect(screen.getByText("fields")).toBeTruthy();
    expect(mounts).toBe(1);
  });

  it("still rebuilds the subtree when the manager switches workspace", async () => {
    renderPortal();
    await answer("w1", "My workspace");
    expect(mounts).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: /Filter/ }));
    expect(sheet()).not.toBeNull();

    // A switch is a different active id on the next read: per-workspace state goes.
    await act(async () => {
      void refreshWorkspaces?.();
    });
    await answer("w2", "Second workspace");

    expect(mounts).toBe(2);
    expect(sheet()).toBeNull();
  });
});
