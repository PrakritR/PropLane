// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Button } from "@/components/ui/button";
import { RecordActionContext } from "@/components/ui/record-action-context";
import { RecordActionMenu } from "@/components/ui/record-action-menu";

afterEach(() => cleanup());

function renderMenu(actions: ReactNode) {
  render(
    <RecordActionContext.Provider value={{ scope: "row-1", clear: () => {}, actions }}>
      <RecordActionMenu label="Row" activate={() => {}} />
    </RecordActionContext.Provider>,
  );
  fireEvent.keyDown(screen.getByRole("button", { name: "Actions for Row" }), { key: "ArrowDown" });
}

function shape() {
  const menu = screen.getByRole("menu");
  return Array.from(menu.querySelectorAll('[role="menuitem"], [role="separator"]')).map((el) =>
    el.getAttribute("role") === "separator" ? "—" : `${el.textContent}:${el.getAttribute("data-record-action-tone")}`,
  );
}

describe("record ⋯ menu decisions", () => {
  it("groups decisions last: green positives directly above the red Decline, Delete red at the very end", async () => {
    renderMenu(
      <>
        <Button onClick={() => {}}>Delete</Button>
        <Button onClick={() => {}}>Decline</Button>
        <Button onClick={() => {}}>Edit</Button>
        <Button onClick={() => {}}>Approve</Button>
        <Button onClick={() => {}}>Message</Button>
      </>,
    );
    expect(await screen.findByRole("menu"));
    expect(shape()).toEqual(["Edit:neutral", "Message:neutral", "—", "Approve:positive", "Decline:negative", "Delete:destructive"]);
  });

  it("puts every positive decision above the negative one", async () => {
    renderMenu(
      <>
        <Button onClick={() => {}}>Reject</Button>
        <Button onClick={() => {}}>Mark paid</Button>
        <Button onClick={() => {}}>Open</Button>
        <Button onClick={() => {}}>Confirm</Button>
      </>,
    );
    expect(await screen.findByRole("menu"));
    expect(shape()).toEqual(["Open:neutral", "—", "Mark paid:positive", "Confirm:positive", "Reject:negative"]);
  });

  it("draws a 16px leading icon on every plain-text item", async () => {
    renderMenu(
      <>
        <Button onClick={() => {}}>Edit</Button>
        <Button onClick={() => {}}>Approve</Button>
        <Button onClick={() => {}}>Delete</Button>
      </>,
    );
    expect(await screen.findByRole("menu"));
    const items = screen.getAllByRole("menuitem");
    expect(items).toHaveLength(3);
    for (const item of items) {
      const icon = item.querySelector("svg");
      expect(icon, item.textContent ?? "").not.toBeNull();
      expect(icon?.getAttribute("class")).toContain("size-4");
    }
  });
});

describe("record ⋯ menu with one item", () => {
  function renderOnly(actions: ReactNode, activate = () => {}) {
    render(
      <RecordActionContext.Provider value={{ scope: "row-1", clear: () => {}, actions }}>
        <RecordActionMenu label="Row" activate={activate} />
      </RecordActionContext.Provider>,
    );
  }

  it("draws that item as an icon action, not a ⋯", () => {
    const onClick = vi.fn();
    const activate = vi.fn();
    renderOnly(<Button variant="danger" onClick={onClick}>Remove stay</Button>, activate);
    expect(document.querySelector('[data-attr="record-actions-trigger"]')).toBeNull();
    // The accessible name carries the row, the way "Actions for Row" did; the tooltip stays the verb.
    const icon = screen.getByRole("button", { name: "Remove stay · Row" });
    expect(icon.getAttribute("data-slot")).toBe("portal-icon-action");
    expect(icon.className).toContain("text-red-600");
    fireEvent.click(icon);
    expect(activate).toHaveBeenCalledTimes(1);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("keeps the ⋯ for a lone item whose label has no icon of its own", () => {
    // `recordActionIcon` falls back to the ⋯ glyph for an uncatalogued label; drawing the lone action
    // behind it would promise a menu and fire on one tap instead.
    renderOnly(<Button onClick={() => {}}>Mark as something else</Button>);
    expect(screen.getByRole("button", { name: "Actions for Row" }).getAttribute("data-attr")).toBe("record-actions-trigger");
    expect(document.querySelector('[data-slot="portal-icon-action"]')).toBeNull();
  });

  it("keeps the ⋯ when there are two or more items", () => {
    renderOnly(
      <>
        <Button onClick={() => {}}>Edit</Button>
        <Button onClick={() => {}}>Delete</Button>
      </>,
    );
    expect(screen.getByRole("button", { name: "Actions for Row" }).getAttribute("data-attr")).toBe("record-actions-trigger");
    expect(document.querySelector('[data-slot="portal-icon-action"]')).toBeNull();
  });
});
