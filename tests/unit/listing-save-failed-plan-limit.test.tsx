// @vitest-environment jsdom
//
// PLAN-0921-1648: a listing autosave refused by the workspace's own record
// cap (drafts included) used to land in the same dialog as a dropped
// connection — "Try again" that could never succeed, because the same
// refusal fires every time until a slot opens. This proves the dialog now
// tells the two apart: the workspace-full failure renders an upgrade prompt
// with a real way out, and an ordinary transient failure keeps today's
// "Try again" / "Keep editing" shape untouched.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { ListingSaveFailedDialog } from "@/components/portal/listing-wizard-v2/save-failed-dialog";
import { MANAGER_PLAN_PORTAL_URL } from "@/lib/portals/manager-plan-path";

afterEach(() => {
  cleanup();
});

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
    expect(screen.getByText("Kept in this window")).toBeInTheDocument();

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
    // A new tab: the editor behind this dialog still holds the listing that
    // could not be saved, which the "Kept in this window" row promises is safe.
    expect(upgrade?.getAttribute("target")).toBe("_blank");
    expect(upgrade?.getAttribute("rel")).toContain("noopener");
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
    expect(manageDrafts?.getAttribute("target")).toBe("_blank");
    expect(manageDrafts?.getAttribute("rel")).toContain("noopener");
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
