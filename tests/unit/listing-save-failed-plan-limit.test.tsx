// @vitest-environment jsdom
//
// PLAN-0921-1648: a listing autosave refused by the workspace's own record
// cap (drafts included) used to land in the same dialog as a dropped
// connection — "Try again" that could never succeed, because the same
// refusal fires every time until a slot opens. This proves the dialog now
// tells the two apart: the workspace-full failure renders an upgrade prompt
// with a real way out, and an ordinary transient failure keeps today's
// "Try again" / "Keep editing" shape untouched.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const native = vi.hoisted(() => ({ value: false }));
vi.mock("@/lib/native/detect-native", () => ({
  isNativeRuntimeSync: () => native.value,
}));

import { ListingSaveFailedDialog } from "@/components/portal/listing-wizard-v2/save-failed-dialog";
import { MANAGER_PLAN_PORTAL_URL } from "@/lib/portals/manager-plan-path";

beforeEach(() => {
  native.value = false;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  restoreNavigation?.();
});

/** The workspace-full dialog, rendered the way the editor renders it. */
function renderPlanLimit() {
  render(
    <ListingSaveFailedDialog
      open
      reason="workspace full"
      kind="plan_limit"
      limitInfo={{ limit: 10, current: 10 }}
      onKeepEditing={vi.fn()}
      onTryAgain={vi.fn()}
      onLeaveWithoutSaving={vi.fn()}
    />,
  );
}

/**
 * jsdom's `location.assign` is non-configurable, so the whole object is swapped
 * for the one assertion. `restoreNavigation` puts it back.
 */
let restoreNavigation: (() => void) | null = null;
function stubNavigation() {
  const original = window.location;
  const assign = vi.fn();
  Object.defineProperty(window, "location", { configurable: true, writable: true, value: { ...original, assign } });
  restoreNavigation = () => {
    Object.defineProperty(window, "location", { configurable: true, writable: true, value: original });
    restoreNavigation = null;
  };
  return assign;
}

const upgradeLink = () => document.querySelector('[data-attr="listing-save-limit-upgrade"]')! as HTMLElement;
const draftsLink = () => document.querySelector('[data-attr="listing-save-limit-manage-drafts"]')! as HTMLElement;
const leaveConfirm = () => document.querySelector('[data-attr="listing-save-limit-leave-confirm"]');

describe("ListingSaveFailedDialog — plan_limit (workspace record cap)", () => {
  it("renders the upgrade variant with three actions and no Try again", () => {
    const onKeepEditing = vi.fn();
    const onTryAgain = vi.fn();
    const onLeaveWithoutSaving = vi.fn();
    render(
      <ListingSaveFailedDialog
        open
        reason="Could not save your progress — This workspace has reached 10 property records, including drafts. Your work is still here."
        kind="plan_limit"
        limitInfo={{ limit: 10, current: 10, draftCount: 4 }}
        onKeepEditing={onKeepEditing}
        onTryAgain={onTryAgain}
        onLeaveWithoutSaving={onLeaveWithoutSaving}
      />,
    );

    expect(screen.getByText("Workspace is full")).toBeInTheDocument();
    expect(screen.getByText("10 of 10")).toBeInTheDocument();
    expect(screen.getByText("4 drafts")).toBeInTheDocument();
    expect(screen.getByText("Kept while this window stays open")).toBeInTheDocument();

    // No dead retry, and no destructive discard — nothing was written yet.
    expect(document.querySelector('[data-attr="listing-save-failed-retry"]')).toBeNull();
    expect(document.querySelector('[data-attr="listing-save-failed-leave"]')).toBeNull();
    expect(screen.queryByText(/try again/i)).toBeNull();

    const upgrade = document.querySelector('[data-attr="listing-save-limit-upgrade"]');
    const manageDrafts = document.querySelector('[data-attr="listing-save-limit-manage-drafts"]');
    const keepEditing = document.querySelector('[data-attr="listing-save-limit-keep-editing"]');
    expect(upgrade).not.toBeNull();
    expect(manageDrafts).not.toBeNull();
    expect(keepEditing).not.toBeNull();
  });

  it("Upgrade plan links to MANAGER_PLAN_PORTAL_URL", () => {
    render(
      <ListingSaveFailedDialog
        open
        reason="workspace full"
        kind="plan_limit"
        limitInfo={{ limit: 10, current: 10 }}
        onKeepEditing={vi.fn()}
        onTryAgain={vi.fn()}
        onLeaveWithoutSaving={vi.fn()}
      />,
    );

    const upgrade = document.querySelector('[data-attr="listing-save-limit-upgrade"]');
    expect(upgrade?.getAttribute("href")).toBe(MANAGER_PLAN_PORTAL_URL);
    // Never `_blank`: this is an in-app portal route, and the native shell
    // hands a new-tab link to the session-less system browser.
    expect(upgrade?.getAttribute("target")).toBeNull();
  });

  it("Manage drafts links to the Drafts tab of Properties", () => {
    render(
      <ListingSaveFailedDialog
        open
        reason="workspace full"
        kind="plan_limit"
        limitInfo={{ limit: 10, current: 10 }}
        onKeepEditing={vi.fn()}
        onTryAgain={vi.fn()}
        onLeaveWithoutSaving={vi.fn()}
      />,
    );

    const manageDrafts = document.querySelector('[data-attr="listing-save-limit-manage-drafts"]');
    expect(manageDrafts?.getAttribute("href")).toBe("/portal/properties/drafts");
    expect(manageDrafts?.getAttribute("target")).toBeNull();
  });

  it("omits the drafts row when the draft count is unknown", () => {
    render(
      <ListingSaveFailedDialog
        open
        reason="workspace full"
        kind="plan_limit"
        limitInfo={{ limit: 10, current: 10 }}
        onKeepEditing={vi.fn()}
        onTryAgain={vi.fn()}
        onLeaveWithoutSaving={vi.fn()}
      />,
    );

    expect(screen.queryByText("Includes drafts")).toBeNull();
    expect(screen.queryByText(/^\d+ drafts$/)).toBeNull();
  });

  it("Keep editing calls onKeepEditing and never onTryAgain or onLeaveWithoutSaving", () => {
    const onKeepEditing = vi.fn();
    const onTryAgain = vi.fn();
    const onLeaveWithoutSaving = vi.fn();
    render(
      <ListingSaveFailedDialog
        open
        reason="workspace full"
        kind="plan_limit"
        limitInfo={{ limit: 10, current: 10 }}
        onKeepEditing={onKeepEditing}
        onTryAgain={onTryAgain}
        onLeaveWithoutSaving={onLeaveWithoutSaving}
      />,
    );

    fireEvent.click(document.querySelector('[data-attr="listing-save-limit-keep-editing"]')!);
    expect(onKeepEditing).toHaveBeenCalledTimes(1);
    expect(onTryAgain).not.toHaveBeenCalled();
    expect(onLeaveWithoutSaving).not.toHaveBeenCalled();
  });

  it("falls back to the workspace constant when the server sent no numbers", () => {
    render(
      <ListingSaveFailedDialog
        open
        reason="workspace full"
        kind="plan_limit"
        onKeepEditing={vi.fn()}
        onTryAgain={vi.fn()}
        onLeaveWithoutSaving={vi.fn()}
      />,
    );

    expect(screen.getByText("10 of 10")).toBeInTheDocument();
  });
});

describe("ListingSaveFailedDialog — leaving the editor for the plan page", () => {
  it("opens a second tab on the website, leaving the editor mounted and asking nothing", () => {
    const opened = { opener: window } as unknown as Window;
    const open = vi.fn(() => opened);
    vi.stubGlobal("open", open);
    renderPlanLimit();

    fireEvent.click(upgradeLink());

    // Never `noopener` in the features string: every browser returns null when
    // it is set, which this helper could not tell from a blocked pop-up. The
    // opener is severed on the window it got back instead.
    expect(open).toHaveBeenCalledWith(MANAGER_PLAN_PORTAL_URL, "_blank");
    expect((opened as { opener: unknown }).opener).toBeNull();
    expect(leaveConfirm()).toBeNull();
    expect(screen.getByText("Workspace is full")).toBeInTheDocument();
  });

  it("still counts the tab as opened when the new window refuses the opener write", () => {
    const opened = {} as Window;
    Object.defineProperty(opened, "opener", {
      get: () => window,
      set: () => {
        throw new Error("cross-origin");
      },
    });
    vi.stubGlobal("open", vi.fn(() => opened));
    renderPlanLimit();

    fireEvent.click(upgradeLink());

    expect(leaveConfirm()).toBeNull();
    expect(screen.getByText("Workspace is full")).toBeInTheDocument();
  });

  it("confirms when window.open itself throws", () => {
    vi.stubGlobal("open", vi.fn(() => {
      throw new Error("blocked");
    }));
    renderPlanLimit();

    fireEvent.click(upgradeLink());

    expect(screen.getByText("Leave without saving?")).toBeInTheDocument();
  });

  it("in the native shell it never opens a tab — it confirms first, and Stay keeps the editor", () => {
    native.value = true;
    const open = vi.fn(() => ({}) as Window);
    vi.stubGlobal("open", open);
    renderPlanLimit();

    fireEvent.click(draftsLink());

    expect(open).not.toHaveBeenCalled();
    expect(screen.getByText("Leave without saving?")).toBeInTheDocument();

    fireEvent.click(document.querySelector('[data-attr="listing-save-limit-stay"]')!);
    expect(leaveConfirm()).toBeNull();
    expect(screen.getByText("Workspace is full")).toBeInTheDocument();
  });

  it("confirms when the browser blocks the pop-up, and Leave navigates in this tab", () => {
    vi.stubGlobal("open", vi.fn(() => null));
    const assign = stubNavigation();
    renderPlanLimit();

    fireEvent.click(upgradeLink());
    expect(screen.getByText("Leave without saving?")).toBeInTheDocument();

    fireEvent.click(document.querySelector('[data-attr="listing-save-limit-leave"]')!);
    expect(assign).toHaveBeenCalledWith(MANAGER_PLAN_PORTAL_URL);
  });
});

describe("ListingSaveFailedDialog — transient failure (unchanged)", () => {
  it("still renders Try again / Keep editing / Leave without saving, no upgrade chrome", () => {
    const onTryAgain = vi.fn();
    render(
      <ListingSaveFailedDialog
        open
        reason="Could not save your progress. Check your connection. Your work is still here."
        onKeepEditing={vi.fn()}
        onTryAgain={onTryAgain}
        onLeaveWithoutSaving={vi.fn()}
      />,
    );

    expect(screen.getByText("Couldn’t save this listing")).toBeInTheDocument();
    expect(screen.getByText(/check your connection/i)).toBeInTheDocument();
    expect(document.querySelector('[data-attr="listing-save-failed-retry"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="listing-save-failed-keep"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="listing-save-failed-leave"]')).not.toBeNull();
    expect(document.querySelector('[data-attr="listing-save-limit-upgrade"]')).toBeNull();
    expect(document.querySelector('[data-attr="listing-save-limit-manage-drafts"]')).toBeNull();
    expect(screen.queryByText("Workspace is full")).toBeNull();

    fireEvent.click(document.querySelector('[data-attr="listing-save-failed-retry"]')!);
    expect(onTryAgain).toHaveBeenCalledTimes(1);
  });
});
