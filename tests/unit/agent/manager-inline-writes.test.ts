import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Anthropic SDK so the loop never makes a network call.
const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));

// The workspace a credential-bound turn speaks for has its own coverage
// (agent-communication-scope.test.ts); an open scope stands in for this
// allow-list test, which is about which surface may run a write inline.
vi.mock("@/lib/communication/conversation-visibility.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/communication/conversation-visibility.server")>()),
  resolveAgentCommunicationScope: async (ctx: { userId: string }, level = "read") => ({
    viewerId: ctx.userId, level, ownerIds: [ctx.userId], grantedHousesByOwner: new Map(),
    workspaceHouseIds: null, untaggedOwnedVisible: true, activeWorkspaceId: null, workspaceByLine: new Map(),
  }),
}));

import { runAgentTurn } from "@/lib/agent/loop";
import { agentRegistry, MANAGER_INLINE_WRITE_TOOLS } from "@/lib/tools";
import { MANAGER_INBOX_SCOPE } from "@/lib/portal-inbox-thread-scope";
import { makeWritableCtx } from "../tools/fake-agent-ctx";

/**
 * The manager chat surface's inline-write allowlist, end to end through the
 * REAL registry: `update_thread` (inbox housekeeping) runs inline like a read,
 * while a money write with the same registry and the same allowlist still
 * halts the turn with a confirm card. Nothing about a TOOL opts it out of the
 * gate — only a surface can allow-list one, and this pins which surface does.
 */
const usage = { input_tokens: 10, output_tokens: 5 };

function seededCtx() {
  return makeWritableCtx({
    portal_inbox_thread_records: [
      {
        id: "t1",
        scope: MANAGER_INBOX_SCOPE,
        owner_user_id: "manager_a",
        row_data: {
          id: "t1",
          folder: "inbox",
          from: "Pat Doe",
          email: "pat@x.com",
          subject: "Leak in unit 2",
          preview: "There is a leak",
          body: "There is a leak",
          unread: true,
        },
      },
    ],
    portal_household_charge_records: [
      {
        id: "hc_1",
        manager_user_id: "manager_a",
        row_data: {
          id: "hc_1",
          createdAt: "2026-06-01T00:00:00.000Z",
          residentEmail: "resident@axis.local",
          residentName: "Pat Resident",
          residentUserId: null,
          propertyId: "prop-1",
          propertyLabel: "12 Main St",
          managerUserId: "manager_a",
          kind: "rent",
          title: "Monthly rent",
          amountLabel: "$1,500.00",
          balanceLabel: "$1,500.00",
          status: "pending",
          blocksLeaseUntilPaid: false,
          dueDateLabel: "Jan 1, 2020",
        },
      },
    ],
    audit_log: [],
  });
}

describe("manager surface inline write allowlist", () => {
  beforeEach(() => {
    create.mockReset();
  });

  it("only allow-lists inbox housekeeping — never a money, mail, or lease write", () => {
    expect([...MANAGER_INLINE_WRITE_TOOLS]).toEqual(["update_thread"]);
  });

  it("runs update_thread inline and continues the turn — no confirm card", async () => {
    create
      .mockResolvedValueOnce({
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "tu_1", name: "update_thread", input: { threadId: "t1", action: "read" } }],
        usage,
      })
      .mockResolvedValueOnce({
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Marked it read." }],
        usage,
      });

    const { ctx, store } = seededCtx();
    const result = await runAgentTurn({
      ctx,
      registry: agentRegistry,
      messages: [{ role: "user", content: "mark the leak thread read" }],
      allowWriteTools: MANAGER_INLINE_WRITE_TOOLS,
    });

    expect(result.pendingAction).toBeUndefined();
    expect(result.reply).toBe("Marked it read.");
    expect(result.toolTrace).toContainEqual({ tool: "update_thread", ok: true });
    expect((store.portal_inbox_thread_records![0]!.row_data as { unread: boolean }).unread).toBe(false);
    // Inline execution is not unaudited execution.
    expect(store.audit_log!.map((r) => r.action)).toContain("update_thread");
  });

  it("still halts on a money write under the SAME allowlist", async () => {
    create.mockResolvedValueOnce({
      stop_reason: "tool_use",
      content: [
        { type: "text", text: "Here's the reminder." },
        { type: "tool_use", id: "tu_1", name: "send_rent_reminder", input: { chargeIds: ["hc_1"] } },
      ],
      usage,
    });

    const { ctx, store } = seededCtx();
    const result = await runAgentTurn({
      ctx,
      registry: agentRegistry,
      messages: [{ role: "user", content: "remind Pat about rent" }],
      allowWriteTools: MANAGER_INLINE_WRITE_TOOLS,
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(result.pendingAction?.toolName).toBe("send_rent_reminder");
    expect(result.pendingAction?.preview.title).toBe("Send rent reminder");
    // Halted at the preview: nothing was sent and nothing was audited.
    expect(store.audit_log).toHaveLength(0);
  });
});
