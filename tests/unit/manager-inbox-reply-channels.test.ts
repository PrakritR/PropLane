import { describe, expect, it } from "vitest";
import {
  inboxThreadHasEmail,
  inboxThreadPhoneHint,
  resolveManagerInboxReplyChannels,
  resolveManagerInboxPortalRecipient,
  resolveManagerInboxSmsTarget,
  resolveCommunicationPersonThreadReplyChannels,
  resolvePropLaneUnifiedReplyChannels,
  resolveAssistantInboxReplyChannels,
  hasInboxReplyChannelSelected,
} from "@/lib/manager-inbox-reply-channels";

describe("manager inbox reply channels", () => {
  it("treats only real emails as email-capable", () => {
    expect(inboxThreadHasEmail("dana@example.com")).toBe(true);
    expect(inboxThreadHasEmail("")).toBe(false);
    expect(inboxThreadHasEmail("+16504484183")).toBe(false);
  });

  it("reads a phone hint from from/email for leasing notices", () => {
    expect(
      inboxThreadPhoneHint({ from: "+16504484183", email: "" }),
    ).toBe("+16504484183");
    expect(
      inboxThreadPhoneHint({ from: "Prospect", email: "+16504484183" }),
    ).toBe("+16504484183");
    expect(inboxThreadPhoneHint({ from: "Dana", email: "dana@example.com" })).toBeNull();
  });

  it("defaults phone-only counterparties to SMS and leaves email off", () => {
    expect(
      resolveManagerInboxReplyChannels({
        emailAvailable: false,
        smsAvailable: true,
        preferred: { viaEmail: true, viaSms: false },
      }),
    ).toEqual({ viaEmail: false, viaSms: true });
  });

  it("defaults email-only counterparties to email", () => {
    expect(
      resolveManagerInboxReplyChannels({
        emailAvailable: true,
        smsAvailable: false,
        preferred: { viaEmail: false, viaSms: true },
      }),
    ).toEqual({ viaEmail: true, viaSms: false });
  });

  it("unified Communication mode enables every available channel", () => {
    expect(
      resolvePropLaneUnifiedReplyChannels({ emailAvailable: true, smsAvailable: true }),
    ).toEqual({ viaEmail: true, viaSms: true });
    expect(
      resolvePropLaneUnifiedReplyChannels({ emailAvailable: false, smsAvailable: true }),
    ).toEqual({ viaEmail: false, viaSms: true });
    expect(
      resolvePropLaneUnifiedReplyChannels({ emailAvailable: true, smsAvailable: false }),
    ).toEqual({ viaEmail: true, viaSms: false });
  });

  it("resolves SMS targets by phone for work-number prospects", () => {
    const target = resolveManagerInboxSmsTarget(
      { from: "+16504484183", email: "" },
      [
        {
          phone: "+16504484183",
          residentEmail: null,
          residentUserId: null,
          conversationKey: "mgr:prospect:+16504484183",
        },
      ],
      true,
    );
    expect(target).toMatchObject({
      phone: "+16504484183",
      conversationKey: "mgr:prospect:+16504484183",
    });
  });

  it("falls back to the thread phone when the SMS directory has not loaded yet", () => {
    const target = resolveManagerInboxSmsTarget(
      { from: "+16504484183", email: "" },
      [],
      true,
    );
    expect(target).toEqual({
      phone: "+16504484183",
      residentEmail: null,
      residentUserId: null,
      conversationKey: null,
    });
  });

  it("keeps SMS unavailable when outbound is disabled", () => {
    expect(
      resolveManagerInboxSmsTarget(
        { from: "+16504484183", email: "" },
        [{ phone: "+16504484183" }],
        false,
      ),
    ).toBeNull();
  });

  it("allows SMS target resolution when the work number can send even if SMS UI is off", () => {
    expect(
      resolveManagerInboxSmsTarget(
        { from: "+16504484183", email: "" },
        [],
        true,
      ),
    ).toMatchObject({ phone: "+16504484183" });
  });

  it("defaults assistant threads to PropLane in-app send", () => {
    expect(resolveAssistantInboxReplyChannels({ emailAvailable: true, smsAvailable: true })).toEqual({
      viaProplane: true,
      viaEmail: false,
      viaSms: false,
    });
    expect(hasInboxReplyChannelSelected({ viaProplane: true, viaEmail: false, viaSms: false })).toBe(true);
  });

  it("defaults Communication person threads to PropLane in-app send", () => {
    expect(
      resolveCommunicationPersonThreadReplyChannels({ emailAvailable: true, smsAvailable: true }),
    ).toEqual({
      viaProplane: true,
      viaEmail: false,
      viaSms: false,
    });
  });

  it("resolves portal recipients for person threads by email or linked resident", () => {
    expect(
      resolveManagerInboxPortalRecipient(
        { email: "dana@example.com" },
        [],
        true,
      ),
    ).toEqual({ toEmails: ["dana@example.com"] });
    expect(
      resolveManagerInboxPortalRecipient(
        { from: "+16504484183", email: "" },
        [{ phone: "+16504484183", residentUserId: "user-1" }],
        true,
      ),
    ).toEqual({ toUserIds: ["user-1"] });
    expect(
      resolveManagerInboxPortalRecipient({ from: "Prospect", email: "" }, [], true),
    ).toBeNull();
  });
});
