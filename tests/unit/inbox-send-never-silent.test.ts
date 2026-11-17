import { describe, expect, it } from "vitest";
import {
  decideManagerInboxSend,
  inboxReplyPickBlocker,
  inboxSendFailureLine,
  INBOX_SEND_NOTHING_REASON,
  INBOX_SEND_NO_RESULT_REASON,
  INBOX_SEND_PICK_A_CHANNEL,
} from "@/lib/manager-inbox-reply-channels";
import { resolveCommunicationInboxThread } from "@/lib/communication-assistant-inbox-list";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";

const row = (id: string): PersistedInboxThread =>
  ({ id, from: "Guest", email: "", subject: "Tour", preview: "", time: "", unread: false, folder: "inbox", messages: [] }) as unknown as PersistedInboxThread;

describe("a manager Send is never silent", () => {
  it("finds the on-screen thread through the resolver when its id is not in the raw list", () => {
    const collapsed = [row("merged-1")];
    const raw = [row("raw-1")];
    expect(raw.find((t) => t.id === "merged-1")).toBeUndefined();
    expect(resolveCommunicationInboxThread("merged-1", collapsed, raw, "manager", "u1")?.id).toBe("merged-1");
  });

  it("no email + phone sends a text", () => {
    const d = decideManagerInboxSend({
      requested: { email: true, sms: false },
      emailAvailable: false,
      smsAvailable: true,
      proplaneAvailable: false,
    });
    expect(d).toMatchObject({ ok: true, email: false, sms: true });
  });

  it("an email sends as email", () => {
    const d = decideManagerInboxSend({
      requested: { email: true, sms: false },
      emailAvailable: true,
      smsAvailable: true,
      proplaneAvailable: false,
    });
    expect(d).toMatchObject({ ok: true, email: true, sms: false });
  });

  it("neither gives the one-line reason", () => {
    const d = decideManagerInboxSend({
      requested: { email: true, sms: true },
      emailAvailable: false,
      smsAvailable: false,
      proplaneAvailable: false,
    });
    expect(d).toEqual({ ok: false, reason: INBOX_SEND_NOTHING_REASON });
    expect(INBOX_SEND_NOTHING_REASON).toContain("no email or phone");
  });

  it("a conversation nothing can reach says so, not \"choose a channel\"", () => {
    // The picker clamps itself to nothing on such a thread, so an empty pick is not the manager's
    // to fix — the reason is.
    expect(
      inboxReplyPickBlocker({
        picked: { viaEmail: false, viaSms: false, viaProplane: false },
        emailAvailable: false,
        smsAvailable: false,
        proplaneAvailable: false,
      }),
    ).toBe(INBOX_SEND_NOTHING_REASON);
  });

  it("an empty pick on a reachable conversation still asks for a channel", () => {
    expect(
      inboxReplyPickBlocker({
        picked: { viaEmail: false, viaSms: false, viaProplane: false },
        emailAvailable: true,
        smsAvailable: false,
        proplaneAvailable: false,
      }),
    ).toBe(INBOX_SEND_PICK_A_CHANNEL);
  });

  it("a pick that cannot be carried is not blocked here — the fallback decides", () => {
    expect(
      inboxReplyPickBlocker({
        picked: { viaEmail: true, viaSms: false, viaProplane: false },
        emailAvailable: false,
        smsAvailable: true,
        proplaneAvailable: false,
      }),
    ).toBeNull();
  });

  it("a send that returns nothing is a visible error line", () => {
    expect(inboxSendFailureLine(null)).toBe(INBOX_SEND_NO_RESULT_REASON);
    expect(inboxSendFailureLine(null, "Quiet hours")).toBe("Quiet hours");
  });
});
