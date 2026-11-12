import { describe, expect, it } from "vitest";
import { conversationVisible, type CommunicationScope } from "@/lib/communication/conversation-visibility.server";

const OWNER = "client-owner";
const STAFF = "staff-1";
const WS = "ws-service";

function scope(over: Partial<CommunicationScope> = {}): CommunicationScope {
  return {
    viewerId: STAFF, level: "read", ownerIds: [STAFF], grantedHousesByOwner: new Map(),
    workspaceHouseIds: new Set(["house-1"]), untaggedOwnedVisible: false, activeWorkspaceId: WS,
    workspaceByLine: new Map(), staffWorkspaceOwners: new Map([[WS, OWNER]]), ...over,
  };
}
const houseless = { ownerId: OWNER, houseIds: [] as string[], threadType: "claw_leasing_sms", threadId: "t1", workspaceId: WS };

describe("service staff read the workspace they run", () => {
  it("staff + house-less thread stamped on the active service workspace is visible", () => {
    expect(conversationVisible(scope(), houseless)).toBe(true);
  });
  it("the same thread is hidden from a self-serve co-manager (no staff entry)", () => {
    expect(conversationVisible(scope({ staffWorkspaceOwners: new Map() }), houseless)).toBe(false);
  });
  it("hidden when another workspace is active", () => {
    expect(conversationVisible(scope({ activeWorkspaceId: "ws-other" }), houseless)).toBe(false);
  });
  it("hidden when the staff entry names a different owner", () => {
    expect(conversationVisible(scope({ staffWorkspaceOwners: new Map([[WS, "someone-else"]]) }), houseless)).toBe(false);
  });
  it("an unstamped thread on the shared line is placed by sharedLineWorkspaceId", () => {
    expect(conversationVisible(scope(), { ...houseless, workspaceId: null, sharedLineWorkspaceId: WS })).toBe(true);
  });
  it("a thread stamped on a different workspace never leaks", () => {
    expect(conversationVisible(scope(), { ...houseless, workspaceId: "ws-other" })).toBe(false);
  });
});
