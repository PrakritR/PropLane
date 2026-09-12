// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AiDraftReplyCard,
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
  // The picker is a VISIBLE segmented control (In-app · Email · Text) with
  // aria-pressed per segment — Mobbin polish §13 — not a dropdown of options.
  const segment = (name: RegExp) => screen.getByRole("button", { name, pressed: undefined });

  it("shows email on and text off but present when sms is unavailable", () => {
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
    const group = screen.getByRole("group", { name: "Send via" });
    expect(group).toHaveTextContent("Email");
    expect(segment(/^Email$/)).toHaveAttribute("aria-pressed", "true");
    const text = segment(/^Text$/);
    expect(text).toBeDisabled();
    expect(text).toHaveAttribute("title", "Texting is off for this conversation");
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
    // Hiding the unreachable channel made it look like SMS was the only
    // option the conversation ever had.
    const email = segment(/^Email$/);
    expect(email).toBeDisabled();
    expect(email).toHaveAttribute("title", "No email address on this conversation");
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
    fireEvent.click(screen.getByRole("button", { name: /Add a phone number/i }));
    expect(onAddPhone).toHaveBeenCalled();
  });

  it("toggles text on beside email — the two are independent", () => {
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
    fireEvent.click(segment(/^Text$/));
    expect(onSms).toHaveBeenCalledWith(true);
    expect(onEmail).toHaveBeenCalledWith(true);
  });

  it("never lets the last channel be switched off — a reply always has one", () => {
    const onEmail = vi.fn();
    render(
      <InboxReplyChannelPicker
        viaEmail
        viaSms={false}
        onViaEmailChange={onEmail}
        onViaSmsChange={vi.fn()}
        emailAvailable
        smsAvailable
      />,
    );
    fireEvent.click(segment(/^Email$/));
    expect(onEmail).not.toHaveBeenCalled();
  });

  it("shows both segments pressed when both are selected, and says who it sends as", () => {
    render(
      <InboxReplyChannelPicker
        viaEmail
        viaSms
        onViaEmailChange={vi.fn()}
        onViaSmsChange={vi.fn()}
        emailAvailable
        smsAvailable
        sendingAs={{ sms: "(206) 555-0100", email: "manager@example.com" }}
      />,
    );
    expect(segment(/^Email$/)).toHaveAttribute("aria-pressed", "true");
    expect(segment(/^Text$/)).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Sending as (206) 555-0100 · manager@example.com")).toBeTruthy();
  });

  it("lists In-app alongside email and text when all channels are available", () => {
    render(
      <InboxReplyChannelPicker
        viaEmail
        viaSms={false}
        viaProplane={false}
        onViaProplaneChange={vi.fn()}
        onViaEmailChange={vi.fn()}
        onViaSmsChange={vi.fn()}
        proplaneAvailable
        emailAvailable
        smsAvailable
      />,
    );
    expect(segment(/^In-app$/)).toBeTruthy();
    expect(segment(/^Email$/)).toBeTruthy();
    expect(segment(/^Text$/)).toBeTruthy();
  });
});

describe("AiDraftReplyCard", () => {
  it("uses a custom generate label when provided", () => {
    render(
      <AiDraftReplyCard
        onApprove={vi.fn()}
        onDiscard={vi.fn()}
        onGenerate={vi.fn()}
        generateLabel="Draft with AI"
      />,
    );
    expect(screen.getByRole("button", { name: "Draft with AI" })).toBeTruthy();
  });
});
