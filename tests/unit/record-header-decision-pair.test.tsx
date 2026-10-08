// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PortalRecordHeaderIconActions } from "@/components/portal/portal-record-section-chrome";
import { ManagerResidentSectionToolbar } from "@/components/portal/manager-resident-section-toolbar";
import { recordSections } from "@/lib/portals/record-sections";
import { splitRecordDecisionActions } from "@/components/portal/portal-record-decision-pair";

afterEach(() => cleanup());

describe("record header: Decline / Approve pair", () => {
  it("renders the decision as a labelled pair, Decline first then Confirm, behind a divider; the rest stay icons", () => {
    const onAction = vi.fn();
    const headerActions = recordSections("manager", "tour", {}).headerActions;
    render(<PortalRecordHeaderIconActions actions={headerActions} onAction={onAction} />);
    const pair = screen.getByRole("group", { name: "Decision" });
    const buttons = Array.from(pair.querySelectorAll("button")).map((b) => b.textContent);
    expect(buttons).toEqual(["Decline", "Confirm"]);
    expect(pair.className).toContain("border-l");
    // Reschedule is not a decision: it stays an icon-only action (the word is only its aria-label).
    const reschedule = screen.getAllByRole("button", { name: "Reschedule" })[0]!;
    expect(reschedule.textContent).toBe("");
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(onAction).toHaveBeenCalledWith("confirm");
  });

  it("the resident Application tab toolbar draws the same pair", () => {
    const onAction = vi.fn();
    const actions = recordSections("manager", "resident", {}, "application").headerActions;
    render(<ManagerResidentSectionToolbar actions={actions} onAction={onAction} />);
    const pair = screen.getByRole("group", { name: "Decision" });
    expect(Array.from(pair.querySelectorAll("button")).map((b) => b.textContent)).toEqual(["Decline", "Approve"]);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    expect(onAction).toHaveBeenCalledWith("approve");
  });

  it("splitRecordDecisionActions takes only approve/confirm and decline/reject", () => {
    const actions = recordSections("manager", "application", {}).headerActions;
    const { rest, positive, negative } = splitRecordDecisionActions(actions);
    expect(positive?.id).toBe("approve");
    expect(negative?.id).toBe("decline");
    expect(rest).toEqual([]);
  });
});

describe("record headers carry no Message unless messaging is the record's core", () => {
  function allHeaderActionIds(kind: string) {
    const base = recordSections("manager", kind, {});
    const ids = new Set<string>(base.headerActions.map((a) => a.id));
    for (const group of base.groups) {
      for (const item of group.items) {
        for (const a of recordSections("manager", kind, {}, item.id).headerActions) ids.add(a.id);
      }
    }
    return ids;
  }

  // Service dropped Message too (captain, Oct 8): Communication is a rail section on the service record.
  it.each(["resident", "property", "service"])("%s: no message / message-* header action on any section", (kind) => {
    const ids = [...allHeaderActionIds(kind)];
    expect(ids.filter((id) => id === "message" || id.startsWith("message-"))).toEqual([]);
  });

  it.each(["vendor", "booking"])("%s keeps its Message header action", (kind) => {
    expect(allHeaderActionIds(kind).has("message")).toBe(true);
  });
});
