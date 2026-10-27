/**
 * A co-host's reply into the workspace owner's thread is delivered under the OWNER's workspace, so that workspace's plan
 * gates it as well as the co-host's own active workspace: a paid co-host cannot deliver into a trial owner's workspace.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  senderRole: "manager" as string,
  access: { allowed: true } as
    | { allowed: true }
    | { allowed: false; reason: "trial" | "plan_unreadable"; status: 402 | 503; message: string },
  assertForWorkspace: vi.fn(),
  paid: new Set<string>(),
  commit: vi.fn(),
  threadWorkspaceId: "ws-owner" as string | null,
  writes: [] as string[],
  recipients: [{ id: "res-1", email: "res@example.com", role: "resident" }] as { id: string; email: string; role: string }[],
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "mate-1", email: "mate@example.com" } } }) },
  }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from(table: string) {
      let isIn = false;
      const chain: Record<string, unknown> = {};
      const rows = () => {
        if (table === "profiles") return isIn ? h.recipients : { role: "manager", full_name: "Mate", email: "mate@example.com" };
        return isIn ? [] : null;
      };
      for (const m of ["select", "eq", "ilike", "order", "limit", "or", "neq", "is", "gte", "lte"]) chain[m] = () => chain;
      chain.in = () => {
        isIn = true;
        return chain;
      };
      for (const m of ["insert", "upsert", "update", "delete"]) {
        chain[m] = () => {
          h.writes.push(`${table}.${m}`);
          return chain;
        };
      }
      chain.maybeSingle = async () => ({ data: rows(), error: null });
      chain.single = async () => ({ data: rows(), error: null });
      chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows(), error: null });
      return chain;
    },
    rpc: async () => ({ data: null, error: null }),
  }),
}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: async () => ({ ok: true }), clientIpFrom: () => "127.0.0.1" }));
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveAuthenticatedBusinessAccess: async () => ({ kind: "live" }),
}));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => false }));
vi.mock("@/lib/inbox-portal-sender", () => ({ resolveInboxSenderRoleForPortal: async () => h.senderRole }));
vi.mock("@/lib/communication/conversation-visibility.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/communication/conversation-visibility.server")>()),
  resolveCommunicationScope: async () => ({
    viewerId: "mate-1",
    level: "edit",
    ownerIds: ["mate-1"],
    grantedHousesByOwner: new Map(),
    workspaceHouseIds: null,
    untaggedOwnedVisible: true,
    activeWorkspaceId: "ws-mate",
    workspaceByLine: new Map(),
  }),
}));
vi.mock("@/lib/inbox-recipient-scope", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/inbox-recipient-scope")>()),
  filterRecipientsBySenderScope: async (_db: unknown, _sender: unknown, recipients: unknown[]) => ({
    allowed: recipients,
  }),
}));
vi.mock("@/lib/property-owner/access.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/property-owner/access.server")>()),
  applyOwnerMessageInboxScope: async (_db: unknown, _who: unknown, recipients: unknown[]) => recipients,
}));
vi.mock("@/lib/manager-communication-access.server", () => ({
  assertManagerCommunicationAllowedForWorkspace: (_db: unknown, _actor: string, workspaceId: string) => {
    h.assertForWorkspace(workspaceId);
    return Promise.resolve(
      h.paid.has(workspaceId)
        ? { allowed: true }
        : { allowed: false, reason: "trial", status: 402, message: "Communication is available on a paid plan." },
    );
  },
  assertManagerCommunicationAllowed: () => Promise.resolve({ allowed: true }),
}));
vi.mock("@/lib/portal-inbox-delivery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/portal-inbox-delivery")>()),
  resolveInboxThreadReplyTarget: async () => ({
    threadId: "thread-1",
    scope: "axis_portal_inbox_manager_v1",
    ownerUserId: "owner-1",
    participantEmail: "res@example.com",
    threadType: "portal_message",
    rowData: { email: "res@example.com", workspaceId: "ws-owner" },
  }),
  commitInboxThreadReply: (...args: unknown[]) => {
    h.commit(...args);
    return Promise.resolve();
  },
}));
vi.mock("@/lib/communication/conversation-key.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/communication/conversation-key.server")>()),
  loadThreadConversation: async () => ({ conversationKey: "mail:res@example.com", workspaceId: h.threadWorkspaceId }),
  replyRecipientsMatchThread: async () => ({ ok: true }),
}));

import { POST } from "@/app/api/portal/send-inbox-message/route";

const reply = () =>
  POST(
    new Request("http://localhost/api/portal/send-inbox-message", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        subject: "Re: Tour",
        text: "See you at two",
        toEmails: ["res@example.com"],
        senderPortal: "manager",
        threadId: "thread-1",
      }),
    }),
  );

beforeEach(() => {
  h.senderRole = "manager";
  h.paid = new Set(["ws-mate"]);
  h.threadWorkspaceId = "ws-owner";
  h.assertForWorkspace.mockClear();
  h.commit.mockClear();
  h.writes.length = 0;
  h.recipients = [{ id: "res-1", email: "res@example.com", role: "resident" }];
});

describe("a co-host reply passes the thread workspace's plan gate", () => {
  it("refuses a paid co-host replying into a trial owner's workspace and delivers nothing", async () => {
    const res = await reply();
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ ok: false, code: "communication_trial" });
    expect(h.assertForWorkspace).toHaveBeenCalledWith("ws-mate");
    expect(h.assertForWorkspace).toHaveBeenCalledWith("ws-owner");
    expect(h.commit).not.toHaveBeenCalled();
    expect(h.writes).toEqual([]);
  });

  it("delivers when the thread's workspace is paid too", async () => {
    h.paid.add("ws-owner");
    const res = await reply();
    expect(res.status).not.toBe(402);
    expect(h.assertForWorkspace).toHaveBeenCalledWith("ws-owner");
    expect(h.commit).toHaveBeenCalledTimes(1);
  });
});
