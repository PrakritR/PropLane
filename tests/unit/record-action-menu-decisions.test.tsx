// @vitest-environment jsdom
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";
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
