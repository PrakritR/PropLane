import { describe, expect, it } from "vitest";
import {
  emailReplySubjectFor,
  emailSubjectTopic,
  inboxEmailBubbleFields,
  inboxTurnDisplayBody,
  latestEmailSubjectFromThreads,
} from "@/lib/inbox-email-display";
import {
  lastInboundChannelFromThreads,
  lastInboundChannelOf,
  type PersistedInboxThread,
} from "@/lib/portal-inbox-storage";

const GMAIL_QUOTE = `Can I come by Friday?

On Tue, Sep 15, 2026 at 2:29 AM Prakrit Ramachandran <
prakrit@example.com> wrote:
> Would Friday suit?`;

function personThread(partial: Partial<PersistedInboxThread> & Pick<PersistedInboxThread, "id">): PersistedInboxThread {
  return {
    folder: "inbox",
    from: "Jordan",
    email: "jordan@example.com",
    subject: "Tour tomorrow?",
    preview: "Can I come by Friday?",
    body: "Can I come by Friday?",
    time: "Sep 16, 2:00 PM",
    unread: true,
    ...partial,
  };
}

describe("inbox email thread display", () => {
  it("shows only the new message, never quoted Gmail history", () => {
    expect(inboxTurnDisplayBody(GMAIL_QUOTE, "email")).toBe("Can I come by Friday?");
    expect(inboxTurnDisplayBody(GMAIL_QUOTE)).toBe("Can I come by Friday?");
    expect(inboxTurnDisplayBody("On my way", "sms")).toBe("On my way");
  });

  it("shows the subject once across Re: replies and prefixes outbound Re:", () => {
    expect(emailSubjectTopic("Re: Tour tomorrow?")).toBe(emailSubjectTopic("Tour tomorrow?"));
    const first = inboxEmailBubbleFields(
      { body: "Can I come by Friday?", subject: "Tour tomorrow?", channel: "email" },
      "",
    );
    expect(first.subject).toBe("Tour tomorrow?");
    const reply = inboxEmailBubbleFields(
      { body: "Yes — 3pm works.", subject: "Re: Tour tomorrow?", channel: "email" },
      first.lastShownSubject,
    );
    expect(reply.subject).toBeUndefined();
    expect(emailReplySubjectFor("Tour tomorrow?")).toBe("Re: Tour tomorrow?");
    expect(emailReplySubjectFor("Re: Tour tomorrow?")).toBe("Re: Tour tomorrow?");
  });

  it("replies by email for a work-email person thread, including an unstamped assistant-email- row", () => {
    const stamped = personThread({
      id: "thr-jordan",
      rootChannel: "email",
      rootSubject: "Tour tomorrow?",
      body: GMAIL_QUOTE,
    });
    expect(lastInboundChannelOf(stamped)).toBe("email");

    const unstampedWorkEmail = personThread({
      id: "assistant-email-abc",
      rootChannel: undefined,
      messages: [],
    });
    expect(lastInboundChannelOf(unstampedWorkEmail)).toBe("email");

    const leftoverSms = personThread({
      id: "older-sms",
      time: "Sep 15, 9:00 AM",
      rootChannel: "sms",
      body: "On my way",
    });
    expect(lastInboundChannelFromThreads([leftoverSms, stamped])).toBe("email");
    expect(latestEmailSubjectFromThreads([stamped])).toBe("Tour tomorrow?");
  });

  it("does not guess email on a legacy unstamped person row", () => {
    const legacy = personThread({ id: "t1", rootChannel: undefined, messages: [] });
    expect(lastInboundChannelOf(legacy)).toBeNull();
    expect(lastInboundChannelFromThreads([legacy])).toBeNull();
  });
});
