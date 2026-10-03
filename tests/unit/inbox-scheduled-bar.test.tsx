// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { InboxScheduledCard, InboxScheduledThreadList } from "@/components/portal/portal-inbox-ui";

afterEach(cleanup);
const card = (id: string, send = vi.fn()) => <InboxScheduledCard key={id} subject={id} body={`Body ${id}`} sendLabel="Oct 4, 9 AM" source="manual" editable onCancel={vi.fn()} onSendNow={send} onSaveEdit={vi.fn()} />;

describe("scheduled conversation bar", () => {
  it("sends the selected row without opening the editor", () => {
    const send = vi.fn();
    render(<InboxScheduledThreadList placement="bar" count={1}>{card("Rent", send)}</InboxScheduledThreadList>);
    fireEvent.click(screen.getByRole("button", { name: "Send now" }));
    expect(send).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).toBeNull();
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
    expect(screen.getAllByRole("button", { name: "Send now" })).toHaveLength(3);
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
    render(<InboxScheduledCard subject="Reminder" body="Original" sendLabel="Tomorrow" source="manual" editable presentation="detail" deliverViaInbox deliverViaEmail={false} deliverViaSms={false} onCancel={vi.fn()} onSendNow={vi.fn()} onSaveEdit={save} />);
    fireEvent.change(screen.getByDisplayValue("Original"), { target: { value: "Updated" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(save).toHaveBeenCalledWith({ subject: "Reminder", body: "Updated" });
  });
});
