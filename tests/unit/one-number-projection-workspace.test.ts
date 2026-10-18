import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/communication/conversation-key.server", () => ({ resolveSmsConversationRef: async () => null }));

import { projectOriginalEvent, resolveSmsProjectionWorkLine } from "@/lib/sms/sms-projection.server";

const OWNER = "owner-1";
const SHARED = "+12065550100";

function db(opts: { workspaces?: string[]; numbers?: unknown[]; rpc?: (name: string, args: unknown) => unknown } = {}) {
  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    rpcCalls,
    db: {
      from: (table: string) => {
        let eqs: Record<string, string> = {};
        const q: Record<string, unknown> = {
          select: () => q, in: () => q, limit: () => q, not: () => q,
          eq: (column: string, value: string) => { eqs = { ...eqs, [column]: value }; return q; },
          maybeSingle: async () => {
            if (table === "sms_runtime_config") return { data: { line_mode: "shared", shared_number_e164: SHARED }, error: null };
            if (table === "portal_workspaces") {
              return opts.workspaces?.includes(eqs.id) && eqs.owner_user_id === OWNER ? { data: { id: eqs.id }, error: null } : { data: null, error: null };
            }
            return { data: null, error: null };
          },
          then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: table === "manager_sms_numbers" ? opts.numbers ?? [] : [], error: null }).then(resolve),
        };
        return q;
      },
      rpc: async (name: string, args: Record<string, unknown>) => {
        rpcCalls.push({ name, args });
        return { data: { conversationId: "c1", turnId: "t1", inserted: true, eventCount: 1 }, error: null };
      },
    } as never,
  };
}

describe("shared-line work line resolution", () => {
  it("places a conversation on the workspace, so one owner's two workspaces never merge", async () => {
    const fixture = db({ workspaces: ["ws-a", "ws-b"] });
    const a = await resolveSmsProjectionWorkLine(fixture.db, { ownerManagerUserId: OWNER, phoneNumber: SHARED, workspaceId: "ws-a" });
    const b = await resolveSmsProjectionWorkLine(fixture.db, { ownerManagerUserId: OWNER, phoneNumber: SHARED, workspaceId: "ws-b" });
    expect(a).toEqual({ workLineId: "ws-a", phoneNumber: SHARED, workspaceId: "ws-a" });
    expect(b?.workLineId).toBe("ws-b");
    expect(a?.workLineId).not.toBe(b?.workLineId);
  });

  it("refuses a workspace the owner does not hold, another number, or no workspace", async () => {
    const fixture = db({ workspaces: ["ws-a"] });
    await expect(resolveSmsProjectionWorkLine(fixture.db, { ownerManagerUserId: OWNER, phoneNumber: SHARED, workspaceId: "ws-other" })).resolves.toBeNull();
    await expect(resolveSmsProjectionWorkLine(fixture.db, { ownerManagerUserId: "intruder", phoneNumber: SHARED, workspaceId: "ws-a" })).resolves.toBeNull();
    await expect(resolveSmsProjectionWorkLine(fixture.db, { ownerManagerUserId: OWNER, phoneNumber: "+12065550777", workspaceId: "ws-a" })).resolves.toBeNull();
    await expect(resolveSmsProjectionWorkLine(fixture.db, { ownerManagerUserId: OWNER, phoneNumber: SHARED })).resolves.toBeNull();
  });
});

const event = {
  ownerManagerUserId: OWNER, counterpartyRole: "prospect" as const, identityKey: "phone:+12065551234", identityKind: "phone" as const,
  counterpartyPhone: "+12065551234", sourceNamespace: "twilio:x", sourceEventId: "SM" + "a".repeat(32),
  direction: "inbound" as const, body: "hi", occurredAt: "2026-10-18T10:00:00.000Z", fromPhone: "+12065551234", toPhone: SHARED,
};

describe("projection RPC choice", () => {
  it("projects a shared-line event through the shared twin with its workspace", async () => {
    const fixture = db();
    await projectOriginalEvent(fixture.db, { ...event, workLineId: "ws-a", workspaceId: "ws-a" });
    expect(fixture.rpcCalls[0].name).toBe("project_shared_line_event");
    expect(fixture.rpcCalls[0].args).toMatchObject({ p_event: { workspaceId: "ws-a", workLineId: "ws-a", ownerManagerUserId: OWNER } });
  });

  it("projects a work-number event through the original RPC, unchanged", async () => {
    const fixture = db();
    await projectOriginalEvent(fixture.db, { ...event, workLineId: "number-1", workspaceId: "ws-a" });
    expect(fixture.rpcCalls[0].name).toBe("project_sms_conversation_event");
    expect(fixture.rpcCalls[0].args).not.toHaveProperty("p_event.workspaceId");
    await projectOriginalEvent(fixture.db, { ...event, workLineId: "number-1" });
    expect(fixture.rpcCalls[1].name).toBe("project_sms_conversation_event");
  });
});
