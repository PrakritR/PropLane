// Readers that used to join a conversation's work line to manager_sms_numbers must treat a
// shared-line conversation (synthetic work line id = workspace id) as the PropLane line.
import { describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";
import { conversationVisible, type CommunicationScope } from "@/lib/communication/conversation-visibility.server";
import { SHARED_LINE_LABEL, sharedLineWorkspaceIdOf, textLineLabel } from "@/lib/one-number/line-label";

vi.mock("server-only", () => ({}));

import { resolveConversationSendLine } from "@/lib/sms/manager-workspace-role.server";

const OWNER = "owner-1";
const SHARED = "+12065550100";

const db = (mode: string | null) =>
  createMemoryDb({
    manager_sms_numbers: [
      { id: "n-a", manager_user_id: OWNER, workspace_id: "ws-a", phone_number: "+12065550001" },
      { id: "n-b", manager_user_id: OWNER, workspace_id: "ws-b", phone_number: "+14255550002" },
    ],
    manager_property_records: [{ id: "hA", manager_user_id: OWNER, workspace_id: "ws-a" }],
    ...(mode ? { sms_runtime_config: [{ singleton: true, line_mode: mode, shared_number_e164: SHARED }] } : {}),
  }) as never;

describe("send line for a shared-line conversation", () => {
  it("answers from the shared number, with no work line row, when the line is shared", async () => {
    const res = await resolveConversationSendLine(db("shared"), OWNER, { linePhones: [SHARED] });
    expect(res).toEqual({ ok: true, numberId: null, phoneNumber: SHARED, via: "shared" });
  });

  it("a work line the conversation used still wins over the shared number", async () => {
    const res = await resolveConversationSendLine(db("shared"), OWNER, { linePhones: [SHARED, "(425) 555-0002"] });
    expect(res).toMatchObject({ ok: true, numberId: "n-b", via: "line" });
  });

  it("per_workspace, shadow, or an unreadable config never match the shared number (two lines stay ambiguous)", async () => {
    for (const mode of ["per_workspace", "shadow", null]) {
      expect(await resolveConversationSendLine(db(mode), OWNER, { linePhones: [SHARED] })).toEqual({ ok: false, reason: "work_line_ambiguous" });
    }
  });

  it("a number that is not the shared number is still refused", async () => {
    expect(await resolveConversationSendLine(db("shared"), OWNER, { linePhones: ["+19995550000"] })).toEqual({ ok: false, reason: "work_line_ambiguous" });
  });
});

describe("visibility of a shared-line conversation", () => {
  const scope = (overrides: Partial<CommunicationScope> = {}): CommunicationScope => ({
    viewerId: OWNER, level: "read", ownerIds: [OWNER], grantedHousesByOwner: new Map(),
    workspaceHouseIds: new Set(["house-b"]), untaggedOwnedVisible: false, activeWorkspaceId: "ws-b", workspaceByLine: new Map([["4255550002", new Set(["ws-b"])]]),
    ...overrides,
  });

  it("is placed by its workspace alone: visible there without a house tag, hidden in any other", () => {
    const input = { ownerId: OWNER, houseIds: [], untaggedTurns: true, lines: [SHARED], sharedLineWorkspaceId: "ws-b" };
    expect(conversationVisible(scope(), input)).toBe(true);
    expect(conversationVisible(scope({ activeWorkspaceId: "ws-a" }), input)).toBe(false);
    expect(conversationVisible(scope({ activeWorkspaceId: null }), input)).toBe(true);
  });

  it("without the shared stamp the old rules apply (a house-less thread is not visible here)", () => {
    expect(conversationVisible(scope(), { ownerId: OWNER, houseIds: [], untaggedTurns: true, lines: [SHARED] })).toBe(false);
  });

  it("another owner's shared-line row still needs the viewer's house grant", () => {
    const co = scope({ viewerId: "co-1", ownerIds: [OWNER], activeWorkspaceId: "ws-b", grantedHousesByOwner: new Map() });
    expect(conversationVisible(co, { ownerId: OWNER, houseIds: ["house-b"], untaggedTurns: true, sharedLineWorkspaceId: "ws-b" })).toBe(false);
    const granted = scope({ viewerId: "co-1", ownerIds: [OWNER], activeWorkspaceId: "ws-b", grantedHousesByOwner: new Map([[OWNER, new Set(["house-b"])]]) });
    expect(conversationVisible(granted, { ownerId: OWNER, houseIds: ["house-b"], untaggedTurns: true, sharedLineWorkspaceId: "ws-b" })).toBe(true);
    expect(conversationVisible(granted, { ownerId: OWNER, houseIds: ["house-b"], untaggedTurns: true, sharedLineWorkspaceId: "ws-a" })).toBe(false);
  });
});

describe("shared line label", () => {
  it("recognises a summary on the shared number and names its workspace", () => {
    expect(sharedLineWorkspaceIdOf({ workLineId: "ws-b", workLinePhone: "(206) 555-0100" }, SHARED)).toBe("ws-b");
    expect(sharedLineWorkspaceIdOf({ workLineId: "n-a", workLinePhone: "+12065550001" }, SHARED)).toBeNull();
    expect(sharedLineWorkspaceIdOf({ workLineId: "ws-b", workLinePhone: SHARED }, null)).toBeNull();
    expect(sharedLineWorkspaceIdOf({ workLineId: null, workLinePhone: SHARED }, SHARED)).toBeNull();
  });

  it("the Text line picker says PropLane line, else the number, else Line n", () => {
    expect(SHARED_LINE_LABEL).toBe("PropLane line");
    expect(textLineLabel({ sharedLine: true, phone: SHARED, index: 0 })).toBe("PropLane line");
    expect(textLineLabel({ phone: "+14255550002", index: 1 })).toBe("+14255550002");
    expect(textLineLabel({ phone: "", index: 1 })).toBe("Line 2");
  });
});
