// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { InboxScheduledCard, InboxScheduledThreadList } from "@/components/portal/portal-inbox-ui";

afterEach(cleanup);
const card = (id: string) => <InboxScheduledCard key={id} subject={id} body={`Body ${id}`} sendLabel="Oct 4, 9 AM" source="manual" editable onCancel={vi.fn()} onSaveEdit={vi.fn()} />;

describe("scheduled conversation bar", () => {
  it("shows no Send now button on a scheduled row", () => {
    render(<InboxScheduledThreadList placement="bar" count={1}>{card("Rent")}</InboxScheduledThreadList>);
    expect(screen.queryByRole("button", { name: "Send now" })).toBeNull();
    expect(screen.getByRole("button", { name: /^Edit Rent/ })).toBeTruthy();
  });

  it("keeps the selected message when an earlier row disappears", () => {
    const { rerender } = render(<InboxScheduledThreadList placement="bar" count={2}>{[card("First"), card("Second")]}</InboxScheduledThreadList>);
    fireEvent.click(screen.getByRole("button", { name: /Expand 2 scheduled messages/ }));
    fireEvent.click(screen.getByRole("button", { name: /Edit Second/ }));
    expect(screen.getByDisplayValue("Body Second")).toBeTruthy();
    rerender(<InboxScheduledThreadList placement="bar" count={1}>{[card("Second")]}</InboxScheduledThreadList>);
    expect(screen.getByDisplayValue("Body Second")).toBeTruthy();
  });

  it("collapses several scheduled sends into one Reminder row that expands and collapses", () => {
    render(<InboxScheduledThreadList placement="bar" count={3}>{[card("First"), card("Second"), card("Third")]}</InboxScheduledThreadList>);
    const summary = screen.getByRole("button", { name: /Expand 3 scheduled messages/ });
    expect(summary.textContent).toContain("Reminder");
    expect(summary.textContent).toContain("First");
    expect(summary.textContent).toContain("+2 more");
    expect(summary.textContent).toContain("Oct 4, 9 AM");
    expect(summary.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryAllByRole("button", { name: /^Edit / })).toHaveLength(0);
    fireEvent.click(summary);
    expect(screen.getAllByRole("button", { name: /^Edit / })).toHaveLength(3);
    expect(screen.queryAllByRole("button", { name: "Send now" })).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /Collapse 3 scheduled messages/ }));
    expect(screen.queryAllByRole("button", { name: /^Edit / })).toHaveLength(0);
  });

  it("renders one scheduled send as a single row with no +0 and no collapse control", () => {
    render(<InboxScheduledThreadList placement="bar" count={1}>{card("Rent")}</InboxScheduledThreadList>);
    expect(screen.getAllByRole("button", { name: /^Edit Rent/ })).toHaveLength(1);
    expect(screen.queryByText(/more/)).toBeNull();
    expect(screen.queryByText(/\+0/)).toBeNull();
    expect(document.querySelector('[data-attr="inbox-scheduled-bar-summary"]')).toBeNull();
  });

  it("opens the Schedule message popup without the left context column", () => {
    render(<InboxScheduledThreadList placement="bar" count={1}>{card("Rent")}</InboxScheduledThreadList>);
    fireEvent.click(screen.getByRole("button", { name: /^Edit Rent/ }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(document.querySelector("[data-popup-context]")).toBeNull();
  });

  it("preserves an in-app-only selection on a body edit", () => {
    const save = vi.fn();
    render(<InboxScheduledCard subject="Reminder" body="Original" sendLabel="Tomorrow" source="manual" editable presentation="detail" deliverViaInbox deliverViaEmail={false} deliverViaSms={false} onCancel={vi.fn()} onSaveEdit={save} />);
    fireEvent.change(screen.getByDisplayValue("Original"), { target: { value: "Updated" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(save).toHaveBeenCalledWith({ subject: "Reminder", body: "Updated" });
  });
});
