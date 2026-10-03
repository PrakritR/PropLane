/**
 * An "All residents" broadcast scheduled in workspace A must reach A's
 * residents only - the same answer the immediate send gives. Delivery runs in a
 * cron with no workspace cookie to read, so the workspace is STAMPED on the row
 * when the manager schedules it and threaded through at send time.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const senderSeen: { reach: unknown; calls: number } = { reach: undefined, calls: 0 };

vi.mock("server-only", () => ({}));
vi.mock("@/lib/inbox-recipient-scope", () => ({
  filterRecipientsBySenderScope: async (_db: unknown, sender: { reach?: unknown }, recipients: unknown[]) => {
    senderSeen.reach = sender.reach;
    senderSeen.calls += 1;
    return { allowed: recipients, blocked: [] };
  },
  recipientReachFromScope: (scope: Record<string, unknown>) => ({ from: "scope", ...scope }),
}));
vi.mock("@/lib/communication/conversation-visibility.server", () => ({
  resolveAgentCommunicationScope: async (
    ctx: { workspace?: { id: string } | null },
  ) => ({
    workspaceHouseIds: new Set([`house-of-${ctx.workspace?.id}`]),
    untaggedOwnedVisible: false,
    grantedHousesByOwner: new Map(),
    activeWorkspaceId: ctx.workspace?.id ?? null,
  }),
}));

import { deliverPortalInboxMessage } from "@/lib/portal-inbox-delivery";

type Row = Record<string, unknown>;

/** Just enough for the sender profile read and the admin-role check. */
function fakeDb() {
  const from = (table: string) => {
    const q: Record<string, unknown> = {
      select: () => q,
      eq: () => q,
      in: () => q,
      order: () => q,
      limit: () => q,
      upsert: async () => ({ data: null, error: null }),
      insert: async () => ({ data: null, error: null }),
      update: () => q,
      delete: () => q,
      single: async () => ({ data: null, error: null }),
      maybeSingle: async () => ({
        data: table === "profiles" ? { role: "manager", sms_from_number: null } : null,
        error: null,
      }),
      then: (resolve: (v: { data: Row[]; error: null }) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve),
    };
    return q;
  };
  return { from } as never;
}

const base = {
  senderUserId: "mgr-1",
  senderEmail: "mgr@x.test",
  fromName: "Mgr",
  subject: "Notice",
  text: "Body",
  toEmails: ["tenant@x.test"],
  senderRole: "manager",
  suppressInbox: true,
  suppressEmail: true,
  suppressSms: true,
};

beforeEach(() => {
  senderSeen.reach = undefined;
  senderSeen.calls = 0;
});

describe("deliverPortalInboxMessage narrows the recipients to the send's workspace", () => {
  it("passes the workspace's reach when the send names one", async () => {
    await deliverPortalInboxMessage(fakeDb(), { ...base, senderWorkspaceId: "ws-a" });
    expect(senderSeen.calls).toBe(1);
    expect(senderSeen.reach).toMatchObject({
      activeWorkspaceId: "ws-a",
      workspaceHouseIds: new Set(["house-of-ws-a"]),
    });
  });

  it("keeps the un-narrowed behaviour for a legacy row that names no workspace", async () => {
    await deliverPortalInboxMessage(fakeDb(), base);
    expect(senderSeen.calls).toBe(1);
    expect(senderSeen.reach).toBeUndefined();
  });

  it("never narrows a resident-composed send by a manager workspace", async () => {
    await deliverPortalInboxMessage(fakeDb(), { ...base, senderRole: "resident", senderWorkspaceId: "ws-a" });
    expect(senderSeen.reach).toBeUndefined();
  });
});
