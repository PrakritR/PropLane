import { describe, expect, it } from "vitest";

import {
  parseTypedConfirmation,
  TYPED_CONFIRMATION_ACTION_KINDS,
  typedConfirmationTarget,
} from "@/lib/axis-assistant/typed-confirmation";
import type { PendingAction } from "@/lib/axis-assistant/use-assistant-conversation";

function pending(kind: string): PendingAction {
  return {
    id: "proposal-1",
    preview: { kind, title: "Send message", confirmLabel: "Send", fields: [{ label: "To", value: "Jordan" }] },
  };
}

describe("parseTypedConfirmation", () => {
  it.each([
    "send",
    "Send",
    "SEND",
    "send.",
    "send!",
    "send it",
    "Send it.",
    "send the message",
    "send the reply",
    "send the email",
    "send this",
    "yes send",
    "yes, send",
    "Yes, send it",
    "yes, send the message",
    "  send  ",
    "yes,   send   it",
  ])("accepts the explicit command %j", (text) => {
    expect(parseTypedConfirmation(text)).toBe(true);
  });

  it.each([
    "",
    "   ",
    "send?",
    "don't send",
    "do not send",
    "send after changing the date",
    "please explain send",
    '"send"',
    "'send'",
    "sending",
    "send it to everyone",
    "yes",
    "yes please",
    "ok send it and also remind them",
    "send\nand then archive",
    "resend",
    "send the invoice",
    "no, send",
  ])("treats %j as an ordinary message", (text) => {
    expect(parseTypedConfirmation(text)).toBe(false);
  });
});

describe("typedConfirmationTarget", () => {
  it("returns the single pending message proposal for an explicit send", () => {
    const action = pending("send_message");
    expect(typedConfirmationTarget("send", action)).toBe(action);
    expect(typedConfirmationTarget("yes, send", action, 0)).toBe(action);
  });

  it.each(TYPED_CONFIRMATION_ACTION_KINDS)("covers the immediate-message kind %s", (kind) => {
    expect(typedConfirmationTarget("send", pending(kind))).not.toBeNull();
  });

  it("is null when nothing is awaiting confirmation", () => {
    expect(typedConfirmationTarget("send", null)).toBeNull();
    expect(typedConfirmationTarget("send", undefined)).toBeNull();
  });

  it.each([
    "schedule_message",
    "send_rent_reminder",
    "approve_and_pay_work_order",
    "delete_property",
    "record_expense",
    "create_lease",
  ])("never approves %s on a bare send", (kind) => {
    expect(typedConfirmationTarget("send", pending(kind))).toBeNull();
    expect(typedConfirmationTarget("yes, send", pending(kind))).toBeNull();
  });

  it("is null when the text is not an explicit command", () => {
    expect(typedConfirmationTarget("send?", pending("send_message"))).toBeNull();
    expect(typedConfirmationTarget("don't send", pending("reply_to_thread"))).toBeNull();
  });

  it("is null when an attachment rides along — that is a new request, not a yes", () => {
    expect(typedConfirmationTarget("send", pending("send_message"), 1)).toBeNull();
  });
});
