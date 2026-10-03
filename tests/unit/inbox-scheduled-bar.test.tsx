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
    fireEvent.click(screen.getByRole("button", { name: /Edit Second/ }));
    expect(screen.getByDisplayValue("Body Second")).toBeTruthy();
    rerender(<InboxScheduledThreadList placement="bar" count={1}>{[card("Second")]}</InboxScheduledThreadList>);
    expect(screen.getByDisplayValue("Body Second")).toBeTruthy();
  });

  it("preserves an in-app-only selection on a body edit", () => {
    const save = vi.fn();
    render(<InboxScheduledCard subject="Reminder" body="Original" sendLabel="Tomorrow" source="manual" editable presentation="detail" deliverViaInbox deliverViaEmail={false} deliverViaSms={false} onCancel={vi.fn()} onSendNow={vi.fn()} onSaveEdit={save} />);
    fireEvent.change(screen.getByDisplayValue("Original"), { target: { value: "Updated" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(save).toHaveBeenCalledWith({ subject: "Reminder", body: "Updated" });
  });
});
