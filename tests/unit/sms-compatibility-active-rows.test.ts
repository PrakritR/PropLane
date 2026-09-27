import { describe, expect, it } from "vitest";
import { buildActiveCommunicationThreads, countUnreadActiveConversations, smsConversationRowId } from "@/lib/communication-active-rows";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";

const notice = {
  id: "sms_notice_test", scope: "axis_portal_inbox_manager_v1", ownerUserId: "manager-1",
  folder: "inbox", from: "+15550001111", email: "", subject: "Text from +15550001111",
  body: "Unbound original or call annotation", preview: "Unbound original or call annotation",
  rootAt: "2026-09-25T12:00:00.000Z", time: "2026-09-25T12:00:00.000Z", unread: true,
} as PersistedInboxThread;

describe("manager Communication compatibility rows", () => {
  it.each([false, true])("keeps an unresolved SMS-like notice when SMS chrome enabled=%s", (smsUiEnabled) => {
    const rows = buildActiveCommunicationThreads([notice], {
      portal: "manager", viewerId: "manager-1", smsUiEnabled,
    });
    expect(rows.some((row) => row.id === notice.id)).toBe(true);
  });

  it.each([false, true])("counts viewer-scoped projection unread with SMS chrome enabled=%s", (smsUiEnabled) => {
    const projection = {
      projectionId: "opaque-projection", conversationKey: "legacy-pair", residentUserId: null,
      residentEmail: null, name: "Prospect", phone: "+15550001111", propertyLabel: null,
      unread: true, archived: false,
      // Last preview is outbound; the server's observed inbound watermark is
      // authoritative even when no inbound message is in this summary page.
      messages: [{ id: "outbound-preview", direction: "outbound" as const, body: "reply", createdAt: "2026-09-25T13:00:00Z" }],
    };
    const opts = { portal: "manager" as const, viewerId: "manager-1", smsUiEnabled,
      smsConversations: [projection], smsOpenedIds: new Set(["outbound-preview"]),
      smsArchivedIds: new Set<string>(), smsHiddenIds: new Set<string>() };
    expect(smsConversationRowId(projection)).toBe("opaque-projection");
    expect(countUnreadActiveConversations([], opts)).toBe(1);
    expect(countUnreadActiveConversations([], { ...opts, smsConversations: [{ ...projection, unread: false }] })).toBe(0);
    expect(countUnreadActiveConversations([], { ...opts, smsConversations: [{ ...projection, archived: true }] })).toBe(0);
    expect(countUnreadActiveConversations([], { ...opts, smsHiddenIds: new Set(["opaque-projection"]) })).toBe(0);
  });
});
