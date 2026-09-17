import { describe, expect, it } from "vitest";
import {
  countVisibleUnreadCommunication,
  filterEmailInboxThreads,
  filterManagerCommunicationThreads,
  isPhoneLikeContact,
  isSmsLikeInboxThread,
  resolveSmsDeletePhone,
} from "@/lib/communication-inbox-filters";
import { PRIMARY_ADMIN_EMAIL } from "@/lib/auth/primary-admin";
import { threadPassesCommunicationFilters } from "@/lib/communication-thread-filters";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";

function thread(partial: Partial<PersistedInboxThread> & Pick<PersistedInboxThread, "id" | "from">): PersistedInboxThread {
  return {
    folder: "inbox",
    email: "",
    subject: "Subject",
    preview: "Preview",
    body: "Body",
    time: "Jul 15",
    unread: true,
    ...partial,
  };
}

describe("communication-inbox-filters", () => {
  it("detects phone-like contacts", () => {
    expect(isPhoneLikeContact("+15105794001")).toBe(true);
    expect(isPhoneLikeContact("Test Resident")).toBe(false);
    expect(isPhoneLikeContact("resident@test.proplane.local")).toBe(false);
  });

  it("filters sms-like threads out of email channel", () => {
    const rows = [
      thread({ id: "email-1", from: "Test Resident", email: "resident@test.proplane.local" }),
      thread({ id: "sms-1", from: "+15105794001" }),
    ];
    expect(filterEmailInboxThreads(rows).map((r) => r.id)).toEqual(["email-1"]);
    expect(isSmsLikeInboxThread(rows[1]!)).toBe(true);
  });

  it("keeps sms-like inbound notices visible when the SMS UI is hidden (keepSmsLike)", () => {
    // When SMS is hidden (A2P not cleared) the SMS panel is gone, so an inbound
    // text must fall through into the unified conversation list rather than be
    // filtered into nowhere and silently disappear.
    const rows = [
      thread({ id: "email-1", from: "Test Resident", email: "resident@test.proplane.local" }),
      thread({ id: "sms-notice", from: "+15105794001", subject: "New SMS in your inbox" }),
    ];
    expect(filterEmailInboxThreads(rows, { keepSmsLike: true }).map((r) => r.id)).toEqual([
      "email-1",
      "sms-notice",
    ]);
  });

  it("filters PropLane admin ops threads out of the manager Communication list", () => {
    const rows = [
      thread({ id: "resident-1", from: "Test Resident", email: "resident@test.proplane.local" }),
      thread({ id: "admin-1", from: "PropLane", email: PRIMARY_ADMIN_EMAIL }),
    ];
    expect(filterManagerCommunicationThreads(rows).map((r) => r.id)).toEqual(["resident-1"]);
  });

  it("uses an SMS conversation's role instead of assuming every SMS row is a resident", () => {
    const filters = { propertyIds: [], roles: ["resident"] as const, contactIds: [] };
    const args = { filters, contacts: [], isResidentThread: true };

    expect(threadPassesCommunicationFilters({ ...args, counterpartyRole: "prospect" })).toBe(false);
    expect(threadPassesCommunicationFilters({ ...args, counterpartyRole: "unknown" })).toBe(false);
    expect(threadPassesCommunicationFilters({ ...args, counterpartyRole: "vendor" })).toBe(false);
    expect(threadPassesCommunicationFilters({ ...args, counterpartyRole: "applicant" })).toBe(true);
    expect(threadPassesCommunicationFilters({ ...args, counterpartyRole: "resident" })).toBe(true);
  });

  it("resolves an SMS delete phone from the row when the directory misses it", () => {
    expect(resolveSmsDeletePhone({
      conversationId: "sms-row-1",
      targetPhone: "",
      rowName: "+15551234567",
    })).toBe("+15551234567");
    expect(resolveSmsDeletePhone({
      conversationId: "+15557654321",
      targetPhone: "",
    })).toBe("+15557654321");
  });

  it("drops leftover assistant notices from the visible unread count", () => {
    const viewerId = "user-1";
    const rows = [
      thread({
        id: "agent_notice_user-1",
        from: "PropLane Assistant",
        unread: false,
        threadType: "agent_notice",
      }),
      thread({
        id: "agent_notice_user-1__ghost",
        from: "PropLane Assistant",
        unread: true,
        threadType: "agent_notice",
      }),
      thread({ id: "email-open", from: "Alex", email: "alex@example.test", unread: true }),
    ];
    expect(countVisibleUnreadCommunication(rows, { portal: "manager", viewerId })).toBe(1);
  });
});
