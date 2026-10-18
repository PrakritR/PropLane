/**
 * The outbound chokepoints besides the compose route: the assistant's message-sending tools and
 * the payment-reminder capability. Each asks `assertManagerCommunicationAllowed*` for the
 * workspace OWNER's plan and refuses before any provider, model or ledger work.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const h = vi.hoisted(() => ({
  access: { allowed: true } as
    | { allowed: true }
    | { allowed: false; reason: "trial" | "plan_unreadable"; status: 402 | 503; message: string },
  forWorkspace: vi.fn(),
  forOwner: vi.fn(),
}));

// The real constants come through (`importOriginal`); only the two asserts are stubbed, so a test
// asserting the refusal copy is asserting the shipped string.
vi.mock("@/lib/manager-communication-access.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/manager-communication-access.server")>()),
  assertManagerCommunicationAllowedForWorkspace: (...args: unknown[]) => {
    h.forWorkspace(...args);
    return Promise.resolve(h.access);
  },
  assertManagerCommunicationAllowed: (...args: unknown[]) => {
    h.forOwner(...args);
    return Promise.resolve(h.access);
  },
}));

import { UNRESOLVED_AGENT_WORKSPACE_SCOPE } from "@/lib/agent/manager-workspace-scope";
import { MANAGER_COMMUNICATION_UNREADABLE_MESSAGE } from "@/lib/manager-communication-access.server";
import { COMMUNICATION_SENDING_TOOLS, scopeManagerTool } from "@/lib/tools/manager-co-manager-tool-scope";
import { defineTool, defineWriteTool } from "@/lib/tools/registry";
import { resolvePaymentReminderCapability } from "@/lib/payment-reminder-capability.server";
import type { AgentContext } from "@/lib/tools/context";

const TRIAL = { allowed: false, reason: "trial", status: 402, message: "Communication is available on a paid plan." } as const;
const ctx = { db: { tag: "db" }, landlordId: "mate-1", userId: "mate-1", workspace: { id: "ws-owner" } } as unknown as AgentContext;

function writeTool(name: string) {
  const handler = vi.fn(async () => ({ reply: "sent" }));
  const preview = vi.fn(async () => ({ kind: name, title: name, confirmLabel: "Send", fields: [] }));
  return { tool: defineWriteTool({ name, description: name, inputSchema: z.object({}), preview, handler }), handler, preview };
}

beforeEach(() => {
  h.access = { allowed: true };
  h.forWorkspace.mockClear();
  h.forOwner.mockClear();
});

describe("assistant tools that message people", () => {
  it("names every message-sending manager tool", () => {
    expect([...COMMUNICATION_SENDING_TOOLS].sort()).toEqual(
      [
        "reply_to_sms_conversation",
        "reply_to_thread",
        "schedule_message",
        "send_message",
        "send_rent_reminder",
        "send_work_order_reminder",
        // Dispatch texts vendors on the manager's behalf.
        "approve_vendor_dispatch",
        "dispatch_vendor",
        // Welcome / invite mail the manager asks the assistant to send.
        "send_resident_welcome",
        "invite_vendor",
        "share_property_link",
      ].sort(),
    );
  });

  it.each([...COMMUNICATION_SENDING_TOOLS])("%s refuses in preview AND handler for a trial owner", async (name) => {
    h.access = TRIAL;
    const { tool, handler, preview } = writeTool(name);
    const scoped = scopeManagerTool(tool);
    if (scoped.kind !== "write") throw new Error("expected a write tool");
    await expect(scoped.preview(ctx, {})).rejects.toThrow("Communication is available on a paid plan.");
    await expect(scoped.handler(ctx, {})).rejects.toThrow("Communication is available on a paid plan.");
    // The plan checked is the active workspace's owner, not the acting teammate's own.
    expect(h.forWorkspace).toHaveBeenCalledWith(ctx.db, "mate-1", "ws-owner");
    expect(handler).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
  });

  it("refuses when the plan cannot be read", async () => {
    h.access = { allowed: false, reason: "plan_unreadable", status: 503, message: "We could not verify your plan." };
    const { tool, handler } = writeTool("send_message");
    const scoped = scopeManagerTool(tool);
    await expect(scoped.handler(ctx, {})).rejects.toThrow("We could not verify your plan.");
    expect(handler).not.toHaveBeenCalled();
  });

  it("refuses on the unresolved-workspace sentinel instead of judging the teammate's own plan", async () => {
    // `UNRESOLVED_AGENT_WORKSPACE_SCOPE` is a PRESENT scope with an empty id. Collapsing it to
    // "no workspace named" would make the acting teammate their own owner, so a co-manager on a
    // paid personal plan could send inside a trial owner's workspace during a workspace-read blip.
    const unresolved = { ...ctx, workspace: UNRESOLVED_AGENT_WORKSPACE_SCOPE } as unknown as AgentContext;
    const { tool, handler, preview } = writeTool("send_message");
    const scoped = scopeManagerTool(tool);
    if (scoped.kind !== "write") throw new Error("expected a write tool");
    await expect(scoped.preview(unresolved, {})).rejects.toThrow(MANAGER_COMMUNICATION_UNREADABLE_MESSAGE);
    await expect(scoped.handler(unresolved, {})).rejects.toThrow(MANAGER_COMMUNICATION_UNREADABLE_MESSAGE);
    // It never reaches the plan read at all: there is no owner it could be asked about.
    expect(h.forWorkspace).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
    expect(preview).not.toHaveBeenCalled();
  });

  it("runs normally for a paid owner", async () => {
    const { tool, handler, preview } = writeTool("send_message");
    const scoped = scopeManagerTool(tool);
    if (scoped.kind !== "write") throw new Error("expected a write tool");
    await scoped.preview(ctx, {});
    await expect(scoped.handler(ctx, {})).resolves.toEqual({ reply: "sent" });
    expect(preview).toHaveBeenCalled();
    expect(handler).toHaveBeenCalled();
  });

  it("never asks about tools that do not message anyone", async () => {
    h.access = TRIAL;
    const read = defineTool({ name: "list_inbox_threads", description: "x", inputSchema: z.object({}), handler: vi.fn(async () => ["t"]) });
    const cancel = writeTool("cancel_scheduled_message");
    await expect(scopeManagerTool(read).handler(ctx, {})).resolves.toEqual(["t"]);
    await expect(scopeManagerTool(cancel.tool).handler(ctx, {})).resolves.toEqual({ reply: "sent" });
    expect(h.forWorkspace).not.toHaveBeenCalled();
  });
});

describe("payment reminder capability", () => {
  it("reports both channels unavailable and blocked for a trial owner, without reading anything else", async () => {
    h.access = TRIAL;
    const db = { from: vi.fn(() => { throw new Error("must not read"); }) };
    const capability = await resolvePaymentReminderCapability(db as never, {
      charge: { id: "c1", residentEmail: "res@example.com" } as never,
      ownerUserId: "owner-1",
      propertyId: "p1",
    });
    expect(h.forOwner).toHaveBeenCalledWith("owner-1");
    expect(capability.blocked).toMatchObject({ reason: "trial", status: 402 });
    expect(capability.email).toEqual({ available: false, reason: "Communication is available on a paid plan." });
    expect(capability.sms.available).toBe(false);
    expect(db.from).not.toHaveBeenCalled();
  });
});
