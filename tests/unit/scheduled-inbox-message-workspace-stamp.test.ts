/**
 * The workspace a scheduled message was composed in is stamped on the row,
 * because delivery runs in a cron with no cookie to read one from. On the
 * delivery side an absent workspace means "narrow nothing", so a scope read
 * that fails here must REFUSE the schedule rather than stamp null - otherwise
 * an "All residents" broadcast widens to every workspace the manager owns
 * through an error path.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const scope: { activeWorkspaceId: string | null; throws: boolean } = {
  activeWorkspaceId: "ws-a",
  throws: false,
};
const created: Record<string, unknown>[] = [];

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

const body = {
  sendAt: new Date(Date.now() + 3_600_000).toISOString(),
  subject: "Notice",
  body: "Body",
  broadcastCategories: ["resident"],
};

const post = () =>
  POST(
    new Request("https://x.test/api/portal/scheduled-inbox-messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  created.length = 0;
  scope.activeWorkspaceId = "ws-a";
  scope.throws = false;
});

describe("scheduling a broadcast stamps the composing workspace", () => {
  it("stamps the active workspace on the row", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(created[0]).toMatchObject({ workspaceId: "ws-a", broadcastCategories: ["resident"] });
  });

  it("stamps null for an account that is not partitioned - which narrows nothing, as before", async () => {
    scope.activeWorkspaceId = null;
    const res = await post();
    expect(res.status).toBe(200);
    expect(created[0]).toMatchObject({ workspaceId: null });
  });

  it("refuses the schedule, retryably, when the workspace cannot be resolved", async () => {
    scope.throws = true;
    const res = await post();
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "WORKSPACE_UNRESOLVED" });
    expect(created).toEqual([]);
  });
});
