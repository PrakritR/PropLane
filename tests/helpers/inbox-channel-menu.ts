/**
 * Drive the reply row's channel menu (`InboxComposerChannelMenu`) the way a
 * person does: open it from its trigger, tick or untick a channel, close it.
 *
 * The menu is a Radix dropdown rendered in a portal. jsdom has no PointerEvent,
 * so the trigger is opened from the keyboard (Enter), which Radix handles the
 * same way as a click; each row is a `menuitemcheckbox` whose `onSelect`
 * prevents the default close, so several channels can be set in one opening.
 */
import { fireEvent, waitFor } from "@testing-library/react";
import { expect } from "vitest";

export type InboxChannelId = "email" | "sms" | "proplane";

export async function setInboxChannelsViaMenu(want: Partial<Record<InboxChannelId, boolean>>) {
  const trigger = await waitFor(() => {
    const el = document.querySelector<HTMLButtonElement>('[data-attr="inbox-reply-send-via"]');
    expect(el).not.toBeNull();
    return el!;
  });
  fireEvent.keyDown(trigger, { key: "Enter" });
  for (const [id, on] of Object.entries(want) as [InboxChannelId, boolean][]) {
    const item = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(`[data-attr="inbox-reply-channel-${id}"]`);
      expect(el).not.toBeNull();
      expect(el!.hasAttribute("data-disabled")).toBe(false);
      return el!;
    });
    if ((item.getAttribute("aria-checked") === "true") !== on) fireEvent.click(item);
    await waitFor(() =>
      expect(document.querySelector(`[data-attr="inbox-reply-channel-${id}"]`)?.getAttribute("aria-checked")).toBe(on ? "true" : "false"),
    );
  }
  fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
}
