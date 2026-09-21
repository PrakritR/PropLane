// @vitest-environment jsdom
//
// Thread-view primitives for the conversation inbox:
//  1. Every bubble carries a channel tag (Email today) — omnichannel-ready.
//  2. A long message renders in FULL (pre-wrap, no clamp/truncate) so a reply
//     bubble never clips.
//  3. Scheduled messages render as a compact chip in the thread; tap opens a
//     compose-style popup with Schedule for later checked.
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import {
  InboxBubble,
  InboxScheduledCard,
  type InboxBubbleMessage,
} from "@/components/portal/portal-inbox-ui";

afterEach(cleanup);

const LONG = "This is a very long reply ".repeat(40).trim();

function openScheduledDetail() {
  const toggle = document.querySelector('[data-attr="inbox-scheduled-toggle"]');
  expect(toggle).toBeTruthy();
  fireEvent.click(toggle!);
}

describe("inbox thread omnichannel primitives", () => {
  it("tags each bubble with its channel when multi-channel timeline requests it", () => {
    const msg: InboxBubbleMessage = {
      id: "m1",
      author: "Dana",
      body: LONG,
      at: "Jul 20",
      direction: "inbound",
      channel: "email",
    };
    render(<InboxBubble message={msg} showChannel />);
    expect(screen.getByText("Email")).toBeTruthy();
    const body = screen.getByText(LONG);
    expect(body).toBeTruthy();
    expect(body.className).not.toMatch(/line-clamp|truncate/);
  });

  it("hides the channel tag on single-channel email threads by default", () => {
    render(<InboxBubble message={{ id: "m2", author: "X", body: "hi", at: "now", direction: "outbound" }} />);
    expect(screen.queryByText("Email")).toBeNull();
  });

  it("shows Sending… under outbound bubbles while delivery is in flight", () => {
    render(
      <InboxBubble
        message={{ id: "m3", author: "You", body: "hello", at: "now", direction: "outbound", delivery: "sending" }}
      />,
    );
    expect(screen.getByText("Sending…")).toBeTruthy();
  });

  it("renders a compact scheduled chip in the thread; full body opens in a popup", () => {
    const { container } = render(
      <InboxScheduledCard
        sendLabel="Jul 25, 2026, 9:00 AM"
        subject="Rent reminder"
        body={LONG}
        source="manual"
        editable
        onCancel={vi.fn()}
        onSendNow={vi.fn()}
        onSaveEdit={vi.fn()}
      />,
    );
    expect(container.querySelector('[data-attr="inbox-scheduled-toggle"]')).toBeTruthy();
    expect(screen.queryByText(LONG)).toBeNull();
    openScheduledDetail();
    expect(screen.getByText(LONG)).toBeTruthy();
    expect(screen.getByText("Schedule")).toBeTruthy();
    expect(screen.queryByText("Send now")).toBeNull();
    expect(screen.queryByText("Cancel send")).toBeNull();
  });

  // A body-only save must NOT emit channel flags. An automated reminder with no
  // override of its own has no stored channel, and that absence is what keeps it
  // following the automation settings — stamping the channels the card merely
  // DISPLAYED would freeze them as an explicit override nobody chose.
  it("compose popup: Schedule saves edits without an Edit step, and without touching channels", () => {
    const onSaveEdit = vi.fn();
    render(
      <InboxScheduledCard
        sendLabel="Jul 25, 2026, 9:00 AM"
        subject="Rent reminder"
        body={LONG}
        source="manual"
        editable
        onCancel={vi.fn()}
        onSendNow={vi.fn()}
        onSaveEdit={onSaveEdit}
      />,
    );
    openScheduledDetail();
    const bodyField = document.querySelector('[data-attr="inbox-scheduled-edit-body"]') as HTMLTextAreaElement;
    expect(bodyField).toBeTruthy();
    fireEvent.change(bodyField, { target: { value: "Edited body" } });
    fireEvent.click(screen.getByText("Schedule"));
    expect(onSaveEdit).toHaveBeenCalledTimes(1);
    const saved = onSaveEdit.mock.calls[0][0] as Record<string, unknown>;
    expect(saved).toMatchObject({ body: "Edited body" });
    expect("deliverViaEmail" in saved).toBe(false);
    expect("deliverViaSms" in saved).toBe(false);
  });

  it("compose popup: a DELIBERATE channel change is still sent with the save", async () => {
    const onSaveEdit = vi.fn();
    render(
      <InboxScheduledCard
        sendLabel="Jul 25, 2026, 9:00 AM"
        subject="Rent reminder"
        body="Original body"
        source="manual"
        smsAvailable
        editable
        onCancel={vi.fn()}
        onSendNow={vi.fn()}
        onSaveEdit={onSaveEdit}
      />,
    );
    openScheduledDetail();
    // The dropdown trigger itself carries the data-attr; the popup locks pointer
    // events on <body>, so drive the menu with plain clicks.
    const sendVia = document.querySelector('[data-attr="inbox-scheduled-edit-send-via"]') as HTMLElement;
    expect(sendVia).toBeTruthy();
    fireEvent.click(sendVia);
    const smsOption = await screen.findByRole("option", { name: /^SMS$/ });
    // A pick is pointerdown + pointerup at the same point.
    fireEvent.pointerDown(smsOption, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(smsOption, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByText("Schedule"));

    expect(onSaveEdit).toHaveBeenCalledTimes(1);
    expect(onSaveEdit.mock.calls[0][0]).toMatchObject({
      body: "Original body",
      deliverViaEmail: true,
      deliverViaSms: true,
    });
  });

  it("keeps the editor open with the draft intact when the save rejects", async () => {
    const onSaveEdit = vi.fn(() => Promise.reject(new Error("Could not save changes.")));
    render(
      <InboxScheduledCard
        sendLabel="Jul 25"
        subject="Rent reminder"
        body="Original body"
        source="manual"
        editable
        onCancel={vi.fn()}
        onSendNow={vi.fn()}
        onSaveEdit={onSaveEdit}
      />,
    );
    openScheduledDetail();
    const bodyField = document.querySelector('[data-attr="inbox-scheduled-edit-body"]') as HTMLTextAreaElement;
    fireEvent.change(bodyField, { target: { value: "Edited body" } });
    fireEvent.click(screen.getByText("Schedule"));

    await waitFor(() =>
      expect(document.querySelector('[data-attr="inbox-scheduled-save-error"]')?.textContent).toBe(
        "Could not save changes.",
      ),
    );
    const stillEditing = document.querySelector('[data-attr="inbox-scheduled-edit-body"]') as HTMLTextAreaElement;
    expect(stillEditing).toBeTruthy();
    expect(stillEditing.value).toBe("Edited body");
  });

  it("detail presentation shows body inline without a toggle chip", () => {
    render(
      <InboxScheduledCard
        sendLabel="Jul 25"
        subject="Rent reminder"
        body="Inline body"
        source="manual"
        editable={false}
        presentation="detail"
        onCancel={vi.fn()}
        onSendNow={vi.fn()}
      />,
    );
    expect(document.querySelector('[data-attr="inbox-scheduled-toggle"]')).toBeNull();
    expect(screen.getByText("Inline body")).toBeTruthy();
  });
});
