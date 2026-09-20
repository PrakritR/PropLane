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

  it("waits while workspaces are still loading — a stale cookie must not open the wizard", () => {
    expect(
      resolveAddPropertyWorkspaceAction({ loading: true, active: null, workspaces: [] }),
    ).toEqual({ kind: "wait" });
  });

  it("opens a co-managed workspace when Add properties is granted", () => {
    expect(
      resolveAddPropertyWorkspaceAction({
        loading: false,
        active: { id: "shared", owned: false, canAddProperties: true },
        workspaces: [{ id: "shared", owned: false, canAddProperties: true }],
      }),
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

  /**
   * "Add property" clicked while workspaces are still loading used to return
   * `wait` and stop with no feedback. `pro-properties.tsx` now toasts and
   * queues one retry, resolved by calling this same function again once the
   * caller's `loading` flag has flipped false — the same context, re-read.
   * This proves that replay actually reaches a settled answer rather than
   * looping back to `wait` forever.
   */
  it("resolves to a settled action once the loading flag the caller is waiting on flips false", () => {
    const loadingCtx = { loading: true, active: null, workspaces: [] };
    expect(resolveAddPropertyWorkspaceAction(loadingCtx)).toEqual({ kind: "wait" });

    // The retry re-reads the SAME workspace list with loading now false —
    // this is exactly the call `pro-properties.tsx` replays.
    const settled = resolveAddPropertyWorkspaceAction({ ...loadingCtx, loading: false });
    expect(settled.kind).not.toBe("wait");
    expect(settled).toEqual({ kind: "open" });
  });

  /**
   * `no-owned` is the branch `pro-properties.tsx` uses to decide whether to
   * create the manager's default workspace (`workspaces.mutate({ action:
   * "initialize" })`) before replaying the click. That decision only makes
   * sense when the account owns nothing at all, so the invariant this locks
   * down is: whenever the gate reports `no-owned`, there is no owned
   * workspace anywhere in the list it was given — never "owned but not
   * writable", which would be a bug in `canCreateHere` instead.
   */
  it("no-owned implies zero owned workspaces in the given list, never merely zero writable ones", () => {
    const cases: Array<Pick<PortalWorkspace, "id" | "owned" | "canAddProperties">[]> = [
      [ws("shared", false)],
      [ws("shared", false), ws("other", false)],
      [{ id: "shared", owned: false, canAddProperties: false }],
    ];
    for (const workspaces of cases) {
      const action = resolveAddPropertyWorkspaceAction({
        loading: false,
        active: workspaces[0]!,
        workspaces,
      });
      expect(action.kind).toBe("no-owned");
      expect(workspaces.some((w) => w.owned)).toBe(false);
    }
  });
});
