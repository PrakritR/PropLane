import { describe, expect, it } from "vitest";
import {
  inboxThreadCounterpartyEmail,
  inboxThreadManagerReplyPending,
  parseTourNotificationGuestEmail,
} from "@/lib/portal-inbox-storage";

describe("parseTourNotificationGuestEmail", () => {
  it("extracts the guest email from a tour manager notification body", () => {
    const body = [
      "Hi,",
      "",
      "Someone requested a property tour through PropLane.",
      "",
      "Guest: Alex Kim (alex@example.com)",
      "Property: Brooklyn House",
    ].join("\n");
    expect(parseTourNotificationGuestEmail(body)).toBe("alex@example.com");
  });
});

describe("inboxThreadCounterpartyEmail", () => {
  it("uses the guest email from a legacy tour notification instead of tours@axis.local", () => {
    const body = "Guest: Alex Kim (alex@example.com)";
    expect(
      inboxThreadCounterpartyEmail({
        email: "tours@axis.local",
        from: "PropLane Tours",
        body,
      }),
    ).toBe("alex@example.com");
  });
});

describe("inboxThreadManagerReplyPending", () => {
  it("returns true for a single inbound resident message", () => {
    expect(
      inboxThreadManagerReplyPending({
        folder: "inbox",
        body: "Can I tour this weekend?",
        messages: [],
      }),
    ).toBe(true);
  });

  it("returns false after the manager has replied", () => {
    expect(
      inboxThreadManagerReplyPending({
        folder: "inbox",
        body: "Can I tour this weekend?",
        messages: [{ id: "m1", from: "Manager", body: "Yes — how about Saturday?", at: "Aug 1" }],
      }),
    ).toBe(false);
  });

  it("returns true when a resident follow-up arrives after an earlier manager reply", () => {
    expect(
      inboxThreadManagerReplyPending({
        folder: "inbox",
        body: "First question",
        messages: [
          { id: "m1", from: "Manager", body: "Thanks for reaching out.", at: "Aug 1" },
          { id: "m2", from: "Resident", body: "I missed the appointment — can we reschedule?", at: "Aug 2", outbound: false },
        ],
      }),
    ).toBe(true);
  });

  it("returns true for a tour notification that only has the system body", () => {
    expect(
      inboxThreadManagerReplyPending({
        folder: "inbox",
        body: "Guest: Alex Kim (alex@example.com)\nNotes from guest:\nI missed the last appointment.",
        messages: [],
      }),
    ).toBe(true);
  });
});
