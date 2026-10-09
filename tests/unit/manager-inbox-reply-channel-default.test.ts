import { describe, expect, it } from "vitest";
import {
  inboxThreadPortalReachable,
  resolveCommunicationPersonThreadReplyChannels,
  resolveStickyReplyChannels,
  type ReplyChannelMemory,
} from "@/lib/manager-inbox-reply-channels";

const none = { viaProplane: false, viaEmail: false, viaSms: false };

describe("default reply channel is the channel the person last used", () => {
  it("answers a text by text, an email by email", () => {
    expect(
      resolveCommunicationPersonThreadReplyChannels({
        emailAvailable: true, smsAvailable: true, lastInboundChannel: "sms", proplaneAvailable: true,
      }),
    ).toEqual({ ...none, viaSms: true });
    expect(
      resolveCommunicationPersonThreadReplyChannels({
        emailAvailable: true, smsAvailable: true, lastInboundChannel: "email", proplaneAvailable: true,
      }),
    ).toEqual({ ...none, viaEmail: true });
  });

  it("keeps the pre-existing in-app default when reachability is not stated", () => {
    expect(
      resolveCommunicationPersonThreadReplyChannels({ emailAvailable: true, smsAvailable: true, lastInboundChannel: null }),
    ).toEqual({ ...none, viaProplane: true });
  });

  it("never lands on In-app for a phone-only person with no stamped inbound", () => {
    expect(
      resolveCommunicationPersonThreadReplyChannels({
        emailAvailable: false, smsAvailable: true, lastInboundChannel: null, proplaneAvailable: false,
      }),
    ).toEqual({ ...none, viaSms: true });
    expect(
      resolveCommunicationPersonThreadReplyChannels({
        emailAvailable: true, smsAvailable: false, lastInboundChannel: null, proplaneAvailable: false,
      }),
    ).toEqual({ ...none, viaEmail: true });
  });

  it("selects nothing (rather than an unreachable In-app) when no channel can deliver", () => {
    expect(
      resolveCommunicationPersonThreadReplyChannels({
        emailAvailable: false, smsAvailable: false, lastInboundChannel: "sms", proplaneAvailable: false,
      }),
    ).toEqual(none);
  });
});

describe("the channel is sticky per thread", () => {
  const args = { emailAvailable: true, smsAvailable: true, proplaneAvailable: true };

  it("keeps a manual pick while the last inbound channel is unchanged", () => {
    const remembered: ReplyChannelMemory = { inbound: "sms", flags: { ...none, viaEmail: true } };
    expect(resolveStickyReplyChannels({ ...args, lastInboundChannel: "sms", remembered })).toEqual({ ...none, viaEmail: true });
  });

  it("goes back to the new inbound channel only when a message arrives on a different one", () => {
    const remembered: ReplyChannelMemory = { inbound: "sms", flags: { ...none, viaEmail: true } };
    expect(resolveStickyReplyChannels({ ...args, lastInboundChannel: "email", remembered })).toEqual({ ...none, viaEmail: true });
    const smsPick: ReplyChannelMemory = { inbound: "email", flags: { ...none, viaSms: true } };
    expect(resolveStickyReplyChannels({ ...args, lastInboundChannel: "sms", remembered: smsPick })).toEqual({ ...none, viaSms: true });
    const stalePick: ReplyChannelMemory = { inbound: "email", flags: { ...none, viaProplane: true } };
    // inbound moved email -> sms: the stale in-app pick is dropped for the text default.
    expect(resolveStickyReplyChannels({ ...args, lastInboundChannel: "sms", remembered: stalePick })).toEqual({ ...none, viaSms: true });
  });

  it("drops a remembered channel that stopped being available", () => {
    const remembered: ReplyChannelMemory = { inbound: "sms", flags: { ...none, viaProplane: true } };
    expect(
      resolveStickyReplyChannels({
        emailAvailable: false, smsAvailable: true, proplaneAvailable: false, lastInboundChannel: "sms", remembered,
      }),
    ).toEqual({ ...none, viaSms: true });
  });

  it("with nothing remembered uses the inbound-channel default", () => {
    expect(resolveStickyReplyChannels({ ...args, lastInboundChannel: "sms" })).toEqual({ ...none, viaSms: true });
  });
});

describe("In-app is offered only to people who can read it", () => {
  const phoneOnly = { from: "+12065550100", email: "" };

  it("hides In-app for a phone-only prospect", () => {
    expect(inboxThreadPortalReachable({ thread: phoneOnly, smsRecipients: [], smsOutboundEnabled: true })).toBe(false);
    expect(
      inboxThreadPortalReachable({
        thread: phoneOnly,
        smsRecipients: [{ phone: "+12065550100", residentEmail: null, residentUserId: null }],
        smsOutboundEnabled: true,
      }),
    ).toBe(false);
  });

  it("offers In-app once the number belongs to a portal account, or the person has an email", () => {
    expect(
      inboxThreadPortalReachable({
        thread: phoneOnly,
        smsRecipients: [{ phone: "+12065550100", residentEmail: "r@example.com", residentUserId: "res-1" }],
        smsOutboundEnabled: true,
      }),
    ).toBe(true);
    expect(
      inboxThreadPortalReachable({ thread: { from: "Dana", email: "dana@example.com" }, smsRecipients: [], smsOutboundEnabled: false }),
    ).toBe(true);
  });

  it("always offers it on assistant and team threads", () => {
    expect(
      inboxThreadPortalReachable({ thread: phoneOnly, smsRecipients: [], smsOutboundEnabled: false, inAppOnlyThread: true }),
    ).toBe(true);
  });
});
