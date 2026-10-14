/** A phone-only scheduled Text: the number must be one of the manager's own conversations. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const scope: { activeWorkspaceId: string | null; throws: boolean } = {
  activeWorkspaceId: "ws-a",
  throws: false,
};
const created: Record<string, unknown>[] = [];
const convos = { residents: [{ phone: "+17262483085", conversationKey: "conv-1" }] };
vi.mock("@/lib/manager-sms-messages.server", () => ({
  fetchManagerSmsConversations: async () => convos,
  resolveSmsScopeManagerIds: async () => [],
}));

vi.mock("@/lib/communication/conversation-visibility.server", () => ({
  resolveCommunicationScope: async () => {
    if (scope.throws) throw new Error("scope read failed");
    return { activeWorkspaceId: scope.activeWorkspaceId };
  },
}));
vi.mock("@/lib/inbox-recipient-scope", () => ({
  filterRecipientsBySenderScope: async (_db: unknown, _sender: unknown, recipients: unknown[]) => ({
    allowed: recipients,
    blocked: [],
  }),
}));
vi.mock("@/lib/scheduled-inbox-messages.server", () => ({
  createScheduledInboxMessage: async (_db: unknown, input: Record<string, unknown>) => {
    created.push(input);
    return input;
  },
  generateScheduledInboxMessageId: () => "sched_test_1",
  loadScheduledInboxMessagesForManager: async () => [],
  loadScheduledInboxMessagesForResident: async () => [],
}));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({
    auth: { getUser: async () => ({ data: { user: { id: "mgr-1", email: "mgr@x.test" } } }) },
  }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => {
    const from = (table: string) => {
      const q: Record<string, unknown> = {
        select: () => q,
        eq: () => q,
        in: () => q,
        order: () => q,
        limit: () => q,
        maybeSingle: async () => ({
          data: table === "profiles" ? { role: "manager", email: "mgr@x.test", full_name: "Mgr" } : null,
          error: null,
        }),
        then: (resolve: (v: { data: unknown[]; error: null }) => unknown) =>
          Promise.resolve({
            data: table === "profile_roles" ? [{ role: "manager" }] : [],
            error: null,
          }).then(resolve),
      };
      return q;
    };
    return { from };
  },
}));

import { POST } from "@/app/api/portal/scheduled-inbox-messages/route";

const post = (extra: Record<string, unknown>) =>
  POST(
    new Request("https://x.test/api/portal/scheduled-inbox-messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sendAt: new Date(Date.now() + 3_600_000).toISOString(),
        subject: "Message for +1 (726) 248-3085",
        body: "See you Thursday",
        deliverViaSms: true,
        ...extra,
      }),
    }),
  );

beforeEach(() => {
  created.length = 0;
  scope.activeWorkspaceId = "ws-a";
  scope.throws = false;
});

describe("phone-only scheduled text", () => {
  it("accepts a number that belongs to a conversation the manager owns", async () => {
    const res = await post({ recipientPhone: "(726) 248-3085", conversationKey: "conv-1" });
    expect(res.status).toBe(200);
    expect(created[0]).toMatchObject({
      recipientEmail: "",
      recipientPhone: "+17262483085",
      conversationKey: "conv-1",
      deliverViaSms: true,
      deliverViaEmail: false,
      deliverViaInbox: false,
      workspaceId: "ws-a",
    });
  });

  it("rejects a phone that is not in the manager's conversations", async () => {
    const res = await post({ recipientPhone: "+12065550100" });
    expect(res.status).toBe(403);
    expect(created).toHaveLength(0);
  });

  it("rejects a phone-only message that is not a text", async () => {
    const res = await post({ recipientPhone: "+17262483085", deliverViaSms: false });
    expect(res.status).toBe(400);
  });
});

vi.mock("@/lib/manager-communication-access.server", () => ({
  assertManagerCommunicationAllowed: vi.fn(async () => ({ allowed: true })),
  assertManagerCommunicationAllowedForWorkspace: vi.fn(async () => ({ allowed: true })),
}));
