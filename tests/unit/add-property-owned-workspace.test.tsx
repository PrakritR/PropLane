// @vitest-environment node
//
// "Add property" must resolve an OWNED workspace before the editor opens — the
// records API refuses a co-managed one, and it did so only after the whole form
// was filled in (PLAN-0916-1119, Decide 2). A non-owned selected workspace
// never opens the editor without switching or asking first.
import { describe, expect, it } from "vitest";
import { resolveAddPropertyWorkspaceAction } from "@/lib/workspaces/add-property-gate";
import type { PortalWorkspace } from "@/lib/workspaces/types";

function ws(id: string, owned: boolean): Pick<PortalWorkspace, "id" | "owned"> {
  return { id, owned };
}

describe("resolveAddPropertyWorkspaceAction", () => {
  it("opens when there is no workspace context (host/tests)", () => {
    expect(resolveAddPropertyWorkspaceAction(null)).toEqual({ kind: "open" });
  });

  it("opens while workspaces are still loading — the server stays the authority", () => {
    expect(
      resolveAddPropertyWorkspaceAction({ loading: true, active: null, workspaces: [] }),
    ).toEqual({ kind: "open" });
  });

  it("opens when no workspace is selected (brand-new account, no cookie)", () => {
    expect(
      resolveAddPropertyWorkspaceAction({ loading: false, active: null, workspaces: [ws("w1", true)] }),
    ).toEqual({ kind: "open" });
  });

  it("opens when the active workspace is already owned", () => {
    expect(
      resolveAddPropertyWorkspaceAction({
        loading: false,
        active: ws("w1", true),
        workspaces: [ws("w1", true), ws("w2", false)],
      }),
    ).toEqual({ kind: "open" });
  });

  it("switches to the one owned workspace when the active one is co-managed", () => {
    // The screenshot case: standing in a co-managed workspace, one owned nearby.
    expect(
      resolveAddPropertyWorkspaceAction({
        loading: false,
        active: ws("shared", false),
        workspaces: [ws("shared", false), ws("mine", true)],
      }),
    ).toEqual({ kind: "switch", workspaceId: "mine" });
  });

  it("asks the manager to pick when several owned workspaces exist", () => {
    expect(
      resolveAddPropertyWorkspaceAction({
        loading: false,
        active: ws("shared", false),
        workspaces: [ws("shared", false), ws("a", true), ws("b", true)],
      }),
    ).toEqual({ kind: "ask-pick" });
  });

  it("reports no-owned when the manager owns none — the editor never opens", () => {
    expect(
      resolveAddPropertyWorkspaceAction({
        loading: false,
        active: ws("shared", false),
        workspaces: [ws("shared", false), ws("other", false)],
      }),
    ).toEqual({ kind: "no-owned" });
  });

  it("never returns 'open' from a co-managed workspace with owned options", () => {
    // The core guarantee: a non-owned selected workspace never opens the editor
    // directly; it switches, asks, or reports no-owned.
    for (const owned of [
      [ws("shared", false), ws("mine", true)],
      [ws("shared", false), ws("a", true), ws("b", true)],
      [ws("shared", false)],
    ]) {
      const action = resolveAddPropertyWorkspaceAction({
        loading: false,
        active: ws("shared", false),
        workspaces: owned,
      });
      expect(action.kind).not.toBe("open");
    }
  });
});
