import { describe, expect, it } from "vitest";
import {
  managerAgentNoticeThreadId,
  managerAgentNoticeVisibleInWorkspace,
  parseManagerAgentNoticeThreadId,
} from "@/lib/communication-manager-assistant-thread";

const MANAGER = "552b562f-e9cb-443b-84ec-48018fc0fa19";
const OTHER = "662c6730-f0dc-554c-95fd-59129fc1fb20";
const BROOKLYN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("managerAgentNoticeThreadId", () => {
  it("keeps the legacy id for the default workspace", () => {
    expect(managerAgentNoticeThreadId(MANAGER)).toBe(`agent_notice_${MANAGER}`);
    expect(managerAgentNoticeThreadId(MANAGER, { id: BROOKLYN, isDefault: true })).toBe(
      `agent_notice_${MANAGER}`,
    );
  });

  it("suffixes a non-default workspace", () => {
    expect(managerAgentNoticeThreadId(MANAGER, { id: BROOKLYN, isDefault: false })).toBe(
      `agent_notice_${MANAGER}__${BROOKLYN}`,
    );
    expect(managerAgentNoticeThreadId(MANAGER, BROOKLYN)).toBe(`agent_notice_${MANAGER}__${BROOKLYN}`);
  });
});

describe("parseManagerAgentNoticeThreadId", () => {
  it("reads legacy and scoped ids, including non-UUID fixtures", () => {
    expect(parseManagerAgentNoticeThreadId(`agent_notice_${MANAGER}`)).toEqual({
      userId: MANAGER,
      workspaceId: null,
    });
    expect(parseManagerAgentNoticeThreadId(`agent_notice_${MANAGER}__${BROOKLYN}`)).toEqual({
      userId: MANAGER,
      workspaceId: BROOKLYN,
    });
    expect(parseManagerAgentNoticeThreadId("agent_notice_viewer-1__ws-brooklyn")).toEqual({
      userId: "viewer-1",
      workspaceId: "ws-brooklyn",
    });
  });
});

describe("managerAgentNoticeVisibleInWorkspace", () => {
  it("shows the legacy id only while the default workspace is active", () => {
    const legacy = `agent_notice_${MANAGER}`;
    expect(managerAgentNoticeVisibleInWorkspace(legacy, MANAGER, BROOKLYN, false)).toBe(false);
    expect(managerAgentNoticeVisibleInWorkspace(legacy, MANAGER, BROOKLYN, true)).toBe(true);
    expect(managerAgentNoticeVisibleInWorkspace(legacy, OTHER, null, true)).toBe(false);
  });

  it("shows a scoped id only in that workspace", () => {
    const scoped = `agent_notice_${MANAGER}__${BROOKLYN}`;
    expect(managerAgentNoticeVisibleInWorkspace(scoped, MANAGER, BROOKLYN, false)).toBe(true);
    expect(managerAgentNoticeVisibleInWorkspace(scoped, MANAGER, "other-ws", false)).toBe(false);
  });
});
