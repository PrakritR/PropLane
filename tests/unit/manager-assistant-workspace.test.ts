import { describe, expect, it, vi } from "vitest";
import { createConversationFakeDb } from "../helpers/conversation-fake-db";

// A server path must never read the browser's selected workspace.
const activeWorkspace = vi.hoisted(() => vi.fn(async () => ({ id: "cookie-ws", isDefault: false })));
const cookieJar = vi.hoisted(() => vi.fn(() => { throw new Error("cookies() must not be read on a server path"); }));
vi.mock("@/lib/workspaces/active.server", () => ({ resolveActiveWorkspaceFromRequest: activeWorkspace }));
vi.mock("next/headers", () => ({ cookies: cookieJar }));

import {
  resolveManagerAssistantThreadWorkspace,
  resolveManagerAssistantWorkspace,
} from "@/lib/communication/manager-assistant-workspace.server";
import { managerAgentNoticeThreadId } from "@/lib/communication-manager-assistant-thread";

const USER = "mgr-1";
const DEFAULT_WS = "ws-default";
const OTHER_WS = "ws-second";
const LINE_WS = "ws-line";

function seed(extra: Record<string, Record<string, unknown>[]> = {}) {
  return createConversationFakeDb({
    portal_workspaces: [
      { id: DEFAULT_WS, owner_user_id: USER, is_default: true },
      { id: OTHER_WS, owner_user_id: USER, is_default: false },
      { id: LINE_WS, owner_user_id: USER, is_default: false },
    ],
    manager_property_records: [
      { id: "house-default", workspace_id: DEFAULT_WS },
      { id: "house-second", workspace_id: OTHER_WS },
      { id: "house-ghost", workspace_id: "ws-missing" },
    ],
    manager_sms_numbers: [{ id: "line-1", workspace_id: LINE_WS }],
    ...extra,
  });
}

describe("resolveManagerAssistantWorkspace", () => {
  it("falls back to the user's default workspace", async () => {
    const resolved = await resolveManagerAssistantWorkspace(seed(), USER);
    expect(resolved).toEqual({ workspaceId: DEFAULT_WS, isDefault: true });
  });

  it("normalizes: the real default workspace always yields the unsuffixed id, whichever rule named it", async () => {
    const db = seed();
    for (const hints of [{ workspaceId: DEFAULT_WS }, { propertyId: "house-default" }, {}]) {
      const workspace = await resolveManagerAssistantThreadWorkspace(db, USER, hints);
      expect(managerAgentNoticeThreadId(USER, workspace)).toBe(`agent_notice_${USER}`);
    }
  });

  it("a non-default workspace gets the suffixed id", async () => {
    const workspace = await resolveManagerAssistantThreadWorkspace(seed(), USER, { propertyId: "house-second" });
    expect(managerAgentNoticeThreadId(USER, workspace)).toBe(`agent_notice_${USER}__${OTHER_WS}`);
  });

  it("precedence: explicit workspace, then the house, then the work line, then the default", async () => {
    const db = seed();
    const all = { workspaceId: OTHER_WS, propertyId: "house-default", workLineId: "line-1" };
    expect((await resolveManagerAssistantWorkspace(db, USER, all)).workspaceId).toBe(OTHER_WS);
    expect((await resolveManagerAssistantWorkspace(db, USER, { propertyId: "house-second", workLineId: "line-1" })).workspaceId).toBe(OTHER_WS);
    expect((await resolveManagerAssistantWorkspace(db, USER, { workLineId: "line-1" })).workspaceId).toBe(LINE_WS);
    expect((await resolveManagerAssistantWorkspace(db, USER, {})).workspaceId).toBe(DEFAULT_WS);
  });

  it("a lookup miss never forks the default chat into a suffixed id", async () => {
    const db = seed();
    const ghostHouse = await resolveManagerAssistantWorkspace(db, USER, { propertyId: "house-ghost" });
    const unknownWorkspace = await resolveManagerAssistantWorkspace(db, USER, { workspaceId: "ws-nope" });
    const unknownHouse = await resolveManagerAssistantWorkspace(db, USER, { propertyId: "house-nope" });
    for (const resolved of [ghostHouse, unknownWorkspace, unknownHouse]) {
      expect(resolved).toEqual({ workspaceId: DEFAULT_WS, isDefault: true });
    }
  });

  it("a user with no default workspace row yet keeps the legacy unsuffixed chat", async () => {
    const db = createConversationFakeDb({ portal_workspaces: [] });
    const workspace = await resolveManagerAssistantThreadWorkspace(db, USER, { propertyId: "house-x" });
    expect(managerAgentNoticeThreadId(USER, workspace)).toBe(`agent_notice_${USER}`);
  });

  it("never reads the browser cookie or the request's active workspace", async () => {
    await resolveManagerAssistantWorkspace(seed(), USER, { propertyId: "house-second" });
    await resolveManagerAssistantWorkspace(seed(), USER);
    expect(cookieJar).not.toHaveBeenCalled();
    expect(activeWorkspace).not.toHaveBeenCalled();
  });
});
