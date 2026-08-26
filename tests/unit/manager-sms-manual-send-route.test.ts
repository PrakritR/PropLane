import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dispatch: vi.fn(),
  enqueue: vi.fn(),
  fetchConversations: vi.fn(),
  track: vi.fn(),
  outboxStatus: "unknown",
}));

const db = {
  from: (table: string) => {
    if (table !== "sms_outbox") throw new Error(`Unexpected table: ${table}`);
    const builder = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: async () => ({
        data: { status: mocks.outboxStatus, blocked_reason: null },
        error: null,
      }),
    };
    return builder;
  },
};

vi.mock("@/lib/auth/portal-access", () => ({
  getPortalAccessContext: vi.fn(async () => ({
    user: { id: "11111111-1111-4111-8111-111111111111" },
    profile: {},
    roles: ["manager"],
  })),
  hasAdminRole: vi.fn(() => false),
  hasRole: vi.fn(() => true),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => db,
}));
vi.mock("@/lib/manager-sms-messages.server", () => ({
  deleteManagerSmsConversation: vi.fn(),
  fetchManagerSmsConversations: mocks.fetchConversations,
  resolveSmsScopeManagerIds: vi.fn(async () => []),
}));
vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({
  dispatchOwnerSmsOutbox: mocks.dispatch,
  enqueueOwnerSms: mocks.enqueue,
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: mocks.track }));

import { POST } from "@/app/api/manager/sms-conversations/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.outboxStatus = "queued";
  mocks.fetchConversations.mockResolvedValue({
    residents: [
      {
        residentUserId: "22222222-2222-4222-8222-222222222222",
        residentEmail: "resident@example.com",
        phone: "+12065550123",
        conversationKey: "owner:resident:resident",
        counterpartyRole: "resident",
      },
    ],
  });
  mocks.enqueue.mockResolvedValue({
    ok: true,
    outboxId: "33333333-3333-4333-8333-333333333333",
    status: "queued",
    deduplicated: false,
  });
  mocks.dispatch.mockResolvedValue({
    claimed: 1,
    submitted: 0,
    blocked: 0,
    unknown: 1,
  });
});

describe("manager manual SMS send", () => {
  it("refuses to pair a visible conversation identity with a different destination phone", async () => {
    const response = await POST(
      new Request("https://prop-lane.test/api/manager/sms-conversations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "manual_attempt-key_mismatch",
        },
        body: JSON.stringify({
          toPhone: "+12065559999",
          text: "This must not be sent",
          residentUserId: "22222222-2222-4222-8222-222222222222",
        }),
      }),
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "The recipient no longer matches this conversation. Refresh and try again.",
    });
    expect(mocks.enqueue).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("uses the client idempotency key and marks unknown outcomes as do-not-resend", async () => {
    const response = await POST(
      new Request("https://prop-lane.test/api/manager/sms-conversations", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": "manual_attempt-key_0",
        },
        body: JSON.stringify({
          toPhone: "+12065550123",
          text: "Hello",
          residentUserId: "22222222-2222-4222-8222-222222222222",
        }),
      }),
    );
    const body = await response.json();

    expect(mocks.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ dedupeKey: "manager:manual_attempt-key_0" }),
    );
    expect(response.status).toBe(409);
    expect(body).toMatchObject({
      code: "delivery_outcome_unknown",
      status: "unknown",
    });
    expect(body.error).toMatch(/Do not resend/i);
    expect(body.error).not.toMatch(/try again/i);
    expect(mocks.track).not.toHaveBeenCalled();
  });
});
