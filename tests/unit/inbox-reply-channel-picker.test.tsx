// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InboxReplyChannelPicker,
  inboxReplyChannelsToMode,
  inboxReplyModeToChannels,
} from "@/components/portal/portal-inbox-ui";

afterEach(() => cleanup());

describe("inbox reply channel helpers", () => {
  it("maps booleans to mode and back", () => {
    expect(inboxReplyChannelsToMode(true, false)).toBe("email");
    expect(inboxReplyChannelsToMode(false, true)).toBe("sms");
    expect(inboxReplyChannelsToMode(true, true)).toBe("both");
    expect(inboxReplyModeToChannels("both")).toEqual({ viaEmail: true, viaSms: true });
  });
});

describe("InboxReplyChannelPicker", () => {
  it("lists email and sms as independent checkboxes when sms is unavailable", () => {
    render(
      <InboxReplyChannelPicker
        viaEmail
        viaSms={false}
        onViaEmailChange={vi.fn()}
        onViaSmsChange={vi.fn()}
        emailAvailable
        smsAvailable={false}
      />,
    );
    const trigger = screen.getByLabelText("Send via");
    expect(trigger).toHaveTextContent("Email");
    fireEvent.click(trigger);
    expect(screen.getByRole("option", { name: /Email/i })).toBeTruthy();
    expect(screen.getByRole("option", { name: /SMS \(not enabled\)/i })).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Email & SMS/i })).toBeNull();
  });

  it("still lists email when the thread has no address, and offers to add one", () => {
    const onAddEmail = vi.fn();
    render(
      <InboxReplyChannelPicker
        viaEmail={false}
        viaSms
        onViaEmailChange={vi.fn()}
        onViaSmsChange={vi.fn()}
        emailAvailable={false}
        smsAvailable
        onAddEmail={onAddEmail}
      />,
    );
    fireEvent.click(screen.getByLabelText("Send via"));
    // Hiding the unreachable channel made the menu look like SMS was the only
    // option the conversation ever had.
    expect(screen.getByRole("option", { name: /Email \(no address\)/i })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Add an email address/i }));
    expect(onAddEmail).toHaveBeenCalled();
  });

  it("offers to add a phone number when the thread has no sms channel", () => {
    const onAddPhone = vi.fn();
    render(
      <InboxReplyChannelPicker
        viaEmail
        viaSms={false}
        onViaEmailChange={vi.fn()}
        onViaSmsChange={vi.fn()}
        emailAvailable
        smsAvailable={false}
        onAddPhone={onAddPhone}
      />,
    );
    fireEvent.click(screen.getByLabelText("Send via"));
    fireEvent.click(screen.getByRole("button", { name: /Add a phone number/i }));
    expect(onAddPhone).toHaveBeenCalled();
  });

  it("allows selecting email and sms independently when both channels are available", () => {
    const onEmail = vi.fn();
    const onSms = vi.fn();
    render(
      <InboxReplyChannelPicker
        viaEmail
        viaSms={false}
        onViaEmailChange={onEmail}
        onViaSmsChange={onSms}
        emailAvailable
        smsAvailable
      />,
    );
    fireEvent.click(screen.getByLabelText("Send via"));
    const smsOption = screen.getByRole("option", { name: /^SMS$/i });
    // A pick is pointerdown + pointerup at the same point; pointerdown alone is a scroll start.
    fireEvent.pointerDown(smsOption, { pointerId: 1, clientX: 10, clientY: 10 });
    fireEvent.pointerUp(smsOption, { pointerId: 1, clientX: 10, clientY: 10 });
    expect(onSms).toHaveBeenCalledWith(true);
    expect(onEmail).toHaveBeenCalledWith(true);
  });

  it("shows Email & SMS on the trigger when both are selected", () => {
    render(
      <InboxReplyChannelPicker
        viaEmail
        viaSms
        onViaEmailChange={vi.fn()}
        onViaSmsChange={vi.fn()}
        emailAvailable
        smsAvailable
      />,
    );
    expect(screen.getByLabelText("Send via")).toHaveTextContent("Email & SMS");
  });
});
