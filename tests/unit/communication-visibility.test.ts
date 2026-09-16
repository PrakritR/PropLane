import { describe, expect, it } from "vitest";
import {
  conversationVisible,
  emailThreadHouses,
  type CommunicationScope,
} from "@/lib/communication/conversation-visibility.server";

/**
 * Communication is decided per HOUSE and per WORKSPACE by one resolver. These
 * tables pin the three rules: the Assistant thread is one manager's in one
 * workspace, a co-manager sees another owner's conversation only on a granted
 * house, and the active workspace narrows (an untagged conversation lives in
 * the owner's default workspace).
 */

const VIEWER = "viewer-1";
const OWNER = "owner-1";

function scope(overrides: Partial<CommunicationScope> = {}): CommunicationScope {
  return {
    viewerId: VIEWER,
    level: "read",
    ownerIds: [VIEWER],
    grantedHousesByOwner: new Map(),
    workspaceHouseIds: null,
    untaggedOwnedVisible: true,
    activeWorkspaceId: null,
    workspaceByLine: new Map(),
    ...overrides,
  };
}

describe("conversationVisible — PropLane Assistant is one thread per manager per workspace", () => {
  it("shows the viewer's assistant only in the workspace that owns that thread", () => {
    const brooklyn = scope({
      workspaceHouseIds: new Set(["house-z"]),
      untaggedOwnedVisible: false,
      activeWorkspaceId: "ws-brooklyn",
    });
    const roosevelt = scope({
      workspaceHouseIds: new Set(["house-r"]),
      untaggedOwnedVisible: true,
      activeWorkspaceId: "ws-roosevelt",
    });
    expect(conversationVisible(brooklyn, { ownerId: VIEWER, houseIds: [], threadType: "agent_notice" })).toBe(false);
    expect(conversationVisible(brooklyn, { ownerId: VIEWER, houseIds: [], threadId: `agent_notice_${VIEWER}` })).toBe(false);
    expect(conversationVisible(brooklyn, {
      ownerId: VIEWER,
      houseIds: [],
      threadId: `agent_notice_${VIEWER}__ws-brooklyn`,
      threadType: "agent_notice",
    })).toBe(true);
    expect(conversationVisible(roosevelt, { ownerId: VIEWER, houseIds: [], threadId: `agent_notice_${VIEWER}` })).toBe(true);
  });

  it("never shows another owner's assistant thread, even with a full grant on every house", () => {
    const granted = scope({ grantedHousesByOwner: new Map([[OWNER, new Set(["house-a", "house-b"])]]) });
    expect(conversationVisible(granted, { ownerId: OWNER, houseIds: ["house-a"], threadType: "agent_notice" })).toBe(false);
    expect(conversationVisible(granted, { ownerId: OWNER, houseIds: [], threadId: `agent_notice_${OWNER}` })).toBe(false);
  });
});

describe("conversationVisible — sharing is per house", () => {
  const granted = scope({ grantedHousesByOwner: new Map([[OWNER, new Set(["house-a"])]]) });

  it("shows another owner's conversation only when it is about a granted house", () => {
    expect(conversationVisible(granted, { ownerId: OWNER, houseIds: ["house-a"] })).toBe(true);
    expect(conversationVisible(granted, { ownerId: OWNER, houseIds: ["house-b"] })).toBe(false);
    expect(conversationVisible(granted, { ownerId: OWNER, houseIds: ["house-b", "house-a"] })).toBe(true);
  });

  it("never shares a conversation about no house", () => {
    expect(conversationVisible(granted, { ownerId: OWNER, houseIds: [] })).toBe(false);
  });

  it("shares nothing from an owner who granted nothing — an invite is not a grant", () => {
    expect(conversationVisible(granted, { ownerId: "stranger", houseIds: ["house-a"] })).toBe(false);
    expect(conversationVisible(scope(), { ownerId: OWNER, houseIds: ["house-a"] })).toBe(false);
  });
});

describe("conversationVisible — the active workspace narrows", () => {
  it("does not narrow a single-workspace account", () => {
    expect(conversationVisible(scope(), { ownerId: VIEWER, houseIds: ["house-a"] })).toBe(true);
    expect(conversationVisible(scope(), { ownerId: VIEWER, houseIds: [] })).toBe(true);
  });

  it("shows the owner's conversation in the workspace that holds its house", () => {
    const inA = scope({ workspaceHouseIds: new Set(["house-a"]), untaggedOwnedVisible: true });
    const inB = scope({ workspaceHouseIds: new Set(["house-b"]), untaggedOwnedVisible: false });
    expect(conversationVisible(inA, { ownerId: VIEWER, houseIds: ["house-a"] })).toBe(true);
    expect(conversationVisible(inB, { ownerId: VIEWER, houseIds: ["house-a"] })).toBe(false);
  });

  it("keeps an untagged conversation in the owner's default workspace only", () => {
    const defaultActive = scope({ workspaceHouseIds: new Set(["house-a"]), untaggedOwnedVisible: true });
    const otherActive = scope({ workspaceHouseIds: new Set(["house-b"]), untaggedOwnedVisible: false });
    expect(conversationVisible(defaultActive, { ownerId: VIEWER, houseIds: [] })).toBe(true);
    expect(conversationVisible(otherActive, { ownerId: VIEWER, houseIds: [] })).toBe(false);
  });

  it("shows nothing but the workspace-scoped assistant in a brand-new workspace with no houses", () => {
    const empty = scope({
      workspaceHouseIds: new Set(),
      untaggedOwnedVisible: false,
      activeWorkspaceId: "ws-empty",
      grantedHousesByOwner: new Map([[OWNER, new Set(["house-a"])]]),
    });
    expect(conversationVisible(empty, { ownerId: VIEWER, houseIds: ["house-a"] })).toBe(false);
    expect(conversationVisible(empty, { ownerId: VIEWER, houseIds: [] })).toBe(false);
    expect(conversationVisible(empty, { ownerId: OWNER, houseIds: ["house-a"] })).toBe(false);
    expect(conversationVisible(empty, { ownerId: VIEWER, houseIds: [], threadType: "agent_notice" })).toBe(false);
    expect(conversationVisible(empty, {
      ownerId: VIEWER,
      houseIds: [],
      threadId: `agent_notice_${VIEWER}__ws-empty`,
      threadType: "agent_notice",
    })).toBe(true);
  });

  it("requires the SAME house to be both granted and in the workspace for a co-manager", () => {
    const s = scope({
      grantedHousesByOwner: new Map([[OWNER, new Set(["house-a"])]]),
      workspaceHouseIds: new Set(["house-b"]),
      untaggedOwnedVisible: false,
    });
    // Granted on A, workspace holds B: a thread about both is still not visible here.
    expect(conversationVisible(s, { ownerId: OWNER, houseIds: ["house-a", "house-b"] })).toBe(false);
  });

  it("treats a legacy owner-less row as the viewer's own untagged conversation", () => {
    expect(conversationVisible(scope({ untaggedOwnedVisible: false, workspaceHouseIds: new Set(["house-b"]) }), { ownerId: null, houseIds: [] })).toBe(false);
    expect(conversationVisible(scope(), { ownerId: null, houseIds: [] })).toBe(true);
  });
});

/** PostgREST-ish stub: one table, the same rows for any filter chain. */
function stubDb(applications: Record<string, unknown>[]) {
  const chain = {
    select: () => chain,
    in: () => chain,
    order: () => chain,
    range: async (from: number, to: number) => ({ data: applications.slice(from, to + 1), error: null }),
  };
  return { from: () => chain } as never;
}

describe("emailThreadHouses — where an email thread's house comes from", () => {
  const labels = new Map([
    ["house-a", { label: "4709A 8th Ave NE", ownerUserId: OWNER, aliases: ["4709a 8th ave ne"] }],
    ["house-b", { label: "Sunset Flats", ownerUserId: OWNER, aliases: ["sunset flats"] }],
  ]);

  it("trusts a stamped propertyId first", async () => {
    const out = await emailThreadHouses(stubDb([]), [
      { id: "t1", owner_user_id: OWNER, participant_email: "a@x.test", row_data: { propertyId: "house-b" } },
    ], labels);
    expect(out.get("t1")).toEqual([{ propertyId: "house-b", label: "Sunset Flats" }]);
  });

  it("matches the person to every house they applied to with that owner, by email", async () => {
    const db = stubDb([
      { manager_user_id: OWNER, resident_email: "Ambika@Example.test", row_data: { bucket: "pending", stage: "submitted", property: "4709A 8th Ave NE" } },
      { manager_user_id: OWNER, resident_email: "ambika@example.test", row_data: { bucket: "approved", property: "Sunset Flats" } },
      // An in-progress application and another owner's application are not residency.
      { manager_user_id: OWNER, resident_email: "ambika@example.test", row_data: { bucket: "pending", stage: "In progress", property: "Elsewhere" } },
      { manager_user_id: "other-owner", resident_email: "ambika@example.test", row_data: { bucket: "approved", property: "4709A 8th Ave NE" } },
    ]);
    const out = await emailThreadHouses(db, [
      { id: "t1", owner_user_id: OWNER, participant_email: "ambika@example.test", row_data: {} },
      { id: "t2", owner_user_id: OWNER, participant_email: "nobody@example.test", row_data: {} },
    ], labels);
    expect(out.get("t1")?.map((h) => h.propertyId).sort()).toEqual(["house-a", "house-b"]);
    expect(out.get("t2")).toEqual([]);
  });

  it("leaves a thread untagged when the scan fails rather than guessing", async () => {
    const broken = { from: () => { throw new Error("db down"); } } as never;
    const out = await emailThreadHouses(broken, [
      { id: "t1", owner_user_id: OWNER, participant_email: "ambika@example.test", row_data: {} },
    ], labels);
    expect(out.get("t1")).toEqual([]);
  });
});
