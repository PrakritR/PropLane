// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Button } from "@/components/ui/button";
import { RecordActionContext } from "@/components/ui/record-action-context";
import { RecordActionMenu } from "@/components/ui/record-action-menu";

afterEach(() => cleanup());

function openMenu(name: string) {
  fireEvent.keyDown(screen.getByRole("button", { name: `Actions for ${name}` }), { key: "ArrowDown" });
}

function menuItemShape() {
  const menu = screen.getByRole("menu");
  return Array.from(menu.querySelectorAll('[role="menuitem"], [role="separator"]')).map((el) =>
    el.getAttribute("role") === "separator" ? "—" : el.textContent,
  );
}

/**
 * These mirror the exact `data-record-action-id` values pro-task-list.tsx,
 * pro-payments-ledger-panel.tsx, and bookings-row-overflow.tsx now tag their
 * ⋯ leaves with (PLAN-0920-1058 area 1d) — proving the tagging actually
 * enforces the canonical order (own actions, capped at four · Message ·
 * Copy link/Share · — divider — · Archive · Delete) end to end through
 * `RecordActionMenu`, not just the pure `orderRecordActions` unit.
 */
describe("tagged ⋯ menus render the canonical order", () => {
  it("Tasks row: Edit, Mark done, then Delete after the divider", async () => {
    render(
      <RecordActionContext.Provider
        value={{
          scope: "task-1",
          clear: () => {},
          actions: (
            <>
              <Button data-record-action-id="edit" onClick={() => {}}>Edit</Button>
              <Button data-record-action-id="complete" onClick={() => {}}>Mark done</Button>
              <Button
                className="text-danger"
                data-record-action-id="delete"
                onClick={() => {}}
              >
                Delete
              </Button>
            </>
          ),
        }}
      >
        <RecordActionMenu label="Task row" activate={() => {}} />
      </RecordActionContext.Provider>,
    );
    openMenu("Task row");
    expect(await screen.findByRole("menu"));
    expect(menuItemShape()).toEqual(["Edit", "Mark done", "—", "Delete"]);
  });

  it("Payments row: own actions keep their given order, Delete still sorts after the divider once tagged", async () => {
    render(
      <RecordActionContext.Provider
        value={{
          scope: "charge-1",
          clear: () => {},
          actions: (
            <>
              <Button data-record-action-id="mark-paid" onClick={() => {}}>Mark as paid</Button>
              <Button data-record-action-id="send-reminder" onClick={() => {}}>Send reminder</Button>
              <Button data-record-action-id="edit" onClick={() => {}}>Edit</Button>
              <Button data-record-action-id="delete" onClick={() => {}}>Delete</Button>
            </>
          ),
        }}
      >
        <RecordActionMenu label="Charge row" activate={() => {}} />
      </RecordActionContext.Provider>,
    );
    openMenu("Charge row");
    expect(await screen.findByRole("menu"));
    // "delete" here has no danger styling of its own (payments' plain outline
    // button) — `data-record-action-id="delete"` alone is what must move it
    // after the divider.
    expect(menuItemShape()).toEqual(["Mark as paid", "Send reminder", "Edit", "—", "Delete"]);
  });

  it("Bookings row: own actions, then Message, then Copy link, then Cancel after the divider — even declared out of order", async () => {
    render(
      <RecordActionContext.Provider
        value={{
          scope: "booking-1",
          clear: () => {},
          actions: (
            <>
              <Button variant="danger" data-record-action-id="delete" onClick={() => {}}>Delete booking</Button>
              <Button data-record-action-id="copy-link" onClick={() => {}}>Copy link</Button>
              <Button data-record-action-id="message" onClick={() => {}}>Message Ada</Button>
              <Button data-record-action-id="edit-dates" onClick={() => {}}>Edit dates</Button>
            </>
          ),
        }}
      >
        <RecordActionMenu label="Booking row" activate={() => {}} />
      </RecordActionContext.Provider>,
    );
    openMenu("Booking row");
    expect(await screen.findByRole("menu"));
    expect(menuItemShape()).toEqual(["Edit dates", "Message Ada", "Copy link", "—", "Delete booking"]);
  });
});

/**
 * Regression guard: every action `node` these three builders push must carry
 * `data-record-action-id`, or `RecordActionMenu`'s `splitDestructiveActions`
 * silently falls back to source order for the WHOLE menu the moment any one
 * leaf is untagged (`record-action-menu.tsx`'s `fullyTagged` check).
 */
describe("every ⋯ action node in the tagged builders carries data-record-action-id", () => {
  function countOccurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1;
  }

  it("pro-task-list.tsx's bulkSelectionActions", () => {
    const src = readFileSync(join(process.cwd(), "src/components/portal/pro-task-list.tsx"), "utf8");
    const start = src.indexOf("const bulkSelectionActions = useMemo");
    const end = src.indexOf("return actions;", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    const nodeCount = countOccurrences(body, "node: (");
    const tagCount = countOccurrences(body, "data-record-action-id=");
    expect(nodeCount).toBeGreaterThan(0);
    expect(tagCount).toBe(nodeCount);
  });

  it("pro-payments-ledger-panel.tsx's bulkSelectionActions", () => {
    const src = readFileSync(join(process.cwd(), "src/components/portal/pro-payments-ledger-panel.tsx"), "utf8");
    const start = src.indexOf("const bulkSelectionActions = useMemo");
    const end = src.indexOf("return (\n      <PortalAdaptiveActionRow", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const body = src.slice(start, end);
    const nodeCount = countOccurrences(body, "node: (");
    const tagCount = countOccurrences(body, "data-record-action-id=");
    expect(nodeCount).toBeGreaterThan(0);
    expect(tagCount).toBe(nodeCount);
  });

  it("bookings-row-overflow.tsx's actions", () => {
    const src = readFileSync(join(process.cwd(), "src/components/portal/bookings-row-overflow.tsx"), "utf8");
    const buttonCount = countOccurrences(src, "<Button ");
    const tagCount = countOccurrences(src, "data-record-action-id=");
    expect(buttonCount).toBeGreaterThan(0);
    expect(tagCount).toBe(buttonCount);
  });
});
