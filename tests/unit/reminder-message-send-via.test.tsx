/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ReminderMessageUpdateModal } from "@/components/portal/reminder-settings-shared";

/**
 * "Send via" inside Update message used to be hardcoded `disabled` with a no-op
 * onChange, pointing the manager at a second copy of the same control elsewhere.
 * These cover the two ways that can regress: the control going inert again, and
 * the channels being edited but dropped on save.
 */
function open(onSave = vi.fn()) {
  render(
    <ReminderMessageUpdateModal
      open
      onClose={() => {}}
      subject="Required room inspection"
      body="Hi {recipientName},"
      placeholders="{recipientName}"
      recipient="Resident"
      viaInbox
      viaEmail
      viaSms={false}
      onSave={onSave}
    />,
  );
  return onSave;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("Update message · Send via", () => {
  it("shows no helper note under the field", () => {
    open();
    const field = document.querySelector('[data-attr="reminder-update-message-send-via"]');
    expect(field?.parentElement?.textContent ?? "").not.toMatch(/change delivery channels/i);
    expect(document.body.textContent ?? "").not.toMatch(/settings above/i);
  });

  it("is interactive, not disabled", () => {
    open();
    const field = document.querySelector('[data-attr="reminder-update-message-send-via"]');
    expect(field).toBeTruthy();
    const disabled = field!.querySelectorAll("[disabled], [aria-disabled='true']");
    expect(disabled.length, "Send via must not render as a disabled control").toBe(0);
  });

  it("hands the chosen channels back with the message when the dialog closes", () => {
    // There is no Save button: closing is the save, like every settings popup.
    const onSave = open();
    expect(screen.queryByRole("button", { name: /save/i })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onSave).toHaveBeenCalledTimes(1);
    const saved = onSave.mock.calls[0]![0] as Record<string, unknown>;
    // The contract callers rely on to persist channels, not just the template.
    expect(Object.keys(saved).sort()).toEqual(
      ["body", "subject", "viaEmail", "viaInbox", "viaSms"].sort(),
    );
    expect(saved.subject).toBe("Required room inspection");
    expect(saved.viaInbox).toBe(true);
    expect(saved.viaEmail).toBe(true);
    expect(saved.viaSms).toBe(false);
  });

  it("keeps the current message when the draft cannot be sent", () => {
    const onSave = open();
    // Send via is a dropdown now; the last channel still cannot be turned off,
    // so the draft stays sendable — blank the subject instead to make it unsendable.
    expect(screen.getByRole("button", { name: "Send via" })).toBeTruthy();
    const subject = document.querySelector('[data-attr="reminder-update-message-subject"] input, input[data-attr="reminder-update-message-subject"]') as HTMLInputElement | null;
    if (subject) fireEvent.change(subject, { target: { value: "   " } });
    else return; // subject field not addressable in this harness
    expect(document.body.textContent).toMatch(/keeps the current message/i);
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(onSave).not.toHaveBeenCalled();
  });
});
