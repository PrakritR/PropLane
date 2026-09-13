// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InboxComposerChannelMenu } from "@/components/portal/inbox-composer-tools";

afterEach(() => cleanup());

describe("InboxComposerChannelMenu add controls", () => {
  it("shows + on disabled email and text rows when handlers are provided", async () => {
    const onAddEmail = vi.fn();
    const onAddPhone = vi.fn();
    render(
      <InboxComposerChannelMenu
        viaEmail={false}
        viaSms={false}
        viaProplane
        onViaEmailChange={vi.fn()}
        onViaSmsChange={vi.fn()}
        onViaProplaneChange={vi.fn()}
        emailAvailable={false}
        smsAvailable={false}
        proplaneAvailable
        onAddEmail={onAddEmail}
        onAddPhone={onAddPhone}
        smsDisabledReason="No phone number on this conversation"
      />,
    );

    const trigger = screen.getByRole("button", { name: /Send via/i });
    fireEvent.keyDown(trigger, { key: "Enter" });

    await waitFor(() => {
      expect(document.querySelector('[data-attr="inbox-reply-add-email"]')).not.toBeNull();
      expect(document.querySelector('[data-attr="inbox-reply-add-phone"]')).not.toBeNull();
    });

    fireEvent.click(document.querySelector('[data-attr="inbox-reply-add-email"]')!);
    expect(onAddEmail).toHaveBeenCalledTimes(1);

    fireEvent.click(document.querySelector('[data-attr="inbox-reply-add-phone"]')!);
    expect(onAddPhone).toHaveBeenCalledTimes(1);
  });

  it("does not show + on text when texting is off and no onAddPhone", async () => {
    render(
      <InboxComposerChannelMenu
        viaEmail={false}
        viaSms={false}
        viaProplane
        onViaEmailChange={vi.fn()}
        onViaSmsChange={vi.fn()}
        onViaProplaneChange={vi.fn()}
        emailAvailable={false}
        smsAvailable={false}
        proplaneAvailable
        onAddEmail={vi.fn()}
        smsDisabledReason="Texting is off for this conversation"
      />,
    );

    fireEvent.keyDown(screen.getByRole("button", { name: /Send via/i }), { key: "Enter" });

    await waitFor(() => {
      expect(document.querySelector('[data-attr="inbox-reply-add-email"]')).not.toBeNull();
      expect(document.querySelector('[data-attr="inbox-reply-add-phone"]')).toBeNull();
    });
  });
});
