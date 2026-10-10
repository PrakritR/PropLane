import { beforeEach, describe, expect, it, vi } from "vitest";
import { createConversationFakeDb } from "../helpers/conversation-fake-db";

vi.mock("@/lib/push-notifications.server", () => ({ sendPushToUser: vi.fn(async () => undefined) }));
vi.mock("@/lib/manager-notification-routing.server", () => ({
  resolveManagerNotificationChannels: vi.fn(async () => ({ inbox: true, push: false, sms: false })),
  sendManagerNotificationSms: vi.fn(async () => undefined),
}));
// The browser's selected workspace is hostile here: a server writer that reads it forks the chat.
vi.mock("@/lib/workspaces/active.server", () => ({
  resolveActiveWorkspaceFromRequest: vi.fn(async () => ({ id: "ws-second", isDefault: false })),
}));

import { ensureManagerAgentNoticeThread, notifyManagerFromAgent } from "@/lib/agent-notify.server";

const USER = "mgr-1";
const DEFAULT_WS = "ws-default";
const SECOND_WS = "ws-second";

let db: ReturnType<typeof createConversationFakeDb>;

beforeEach(() => {
  db = createConversationFakeDb({
    portal_workspaces: [
      { id: DEFAULT_WS, owner_user_id: USER, is_default: true },
      { id: SECOND_WS, owner_user_id: USER, is_default: false },
    ],
    manager_property_records: [
      { id: "house-a", workspace_id: DEFAULT_WS },
      { id: "house-b", workspace_id: SECOND_WS },
    ],
  });
});

const assistantIds = () =>
  db.tables.portal_inbox_thread_records!.filter((row) => row.thread_type === "agent_notice").map((row) => row.id);

describe("every Assistant writer lands in the same row", () => {
  it("a webhook notice (no cookie, no house), a house notice and the placeholder write one default-workspace chat", async () => {
    await notifyManagerFromAgent(db, { landlordId: USER, subject: "A", text: "no house" });
    await notifyManagerFromAgent(db, { landlordId: USER, subject: "B", text: "default house", propertyId: "house-a" });
    await ensureManagerAgentNoticeThread(db, USER);
    expect(assistantIds()).toEqual([`agent_notice_${USER}`]);
    const row = db.tables.portal_inbox_thread_records!.find((r) => r.id === `agent_notice_${USER}`)!;
    expect((row.row_data as { messages: unknown[] }).messages).toHaveLength(2);
  });

  it("the cookie's non-default workspace does not capture a notice with no house", async () => {
    await notifyManagerFromAgent(db, { landlordId: USER, subject: "A", text: "x" });
    expect(assistantIds()).toEqual([`agent_notice_${USER}`]);
  });

  it("a house in another workspace gets that workspace's chat, once", async () => {
    await notifyManagerFromAgent(db, { landlordId: USER, subject: "A", text: "x", propertyId: "house-b" });
    await notifyManagerFromAgent(db, { landlordId: USER, subject: "B", text: "y", propertyId: "house-b" });
    expect(assistantIds()).toEqual([`agent_notice_${USER}__${SECOND_WS}`]);
  });

  it("a house whose workspace row is gone falls back to the default chat, not a suffixed one", async () => {
    db.tables.manager_property_records!.push({ id: "house-ghost", workspace_id: "ws-deleted" });
    await notifyManagerFromAgent(db, { landlordId: USER, subject: "A", text: "x", propertyId: "house-ghost" });
    expect(assistantIds()).toEqual([`agent_notice_${USER}`]);
  });
});
