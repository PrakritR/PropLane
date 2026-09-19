import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveContext: vi.fn(),
  runTurn: vi.fn(),
  rateLimit: vi.fn(),
  history: vi.fn(),
  historyDelete: vi.fn(),
  serviceDb: vi.fn(),
}));

vi.mock("@/lib/agent/sms-test-context.server", () => ({
  resolveSmsTestContext: mocks.resolveContext,
}));
vi.mock("@/lib/agent/sms-test-runner.server", () => ({
  runSmsTestTurn: mocks.runTurn,
}));
vi.mock("@/lib/agent/pending-action-decision", () => ({
  agentChatRateLimitResponse: mocks.rateLimit,
}));
vi.mock("@/lib/agent/chat-history-route", () => ({
  handleAgentChatHistoryRequest: mocks.history,
  handleAgentChatHistoryDeleteRequest: mocks.historyDelete,
}));
vi.mock("@/lib/agent/assistant-stream", () => ({
  assistantResponse: (_request: Request, payload: Record<string, unknown>) =>
    Response.json(payload),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: mocks.serviceDb,
}));

import { DELETE, GET, POST } from "@/app/api/agent/sms-test/route";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const MANAGER = "22222222-2222-4222-8222-222222222222";

const context = {
  capability: {
    enabled: true,
    portal: "resident",
    actorUserId: ACTOR,
    actorName: "Alex",
    targets: [],
  },
  mode: "prospect",
  stage: "prospect",
  managerUserId: MANAGER,
  sessionKind: `leasing_sms_test:${MANAGER}:listing-1`,
  target: {
    listingId: "listing-1",
    managerUserId: MANAGER,
    title: "Oak Home",
    address: "1 Oak St",
  },
  actorEmail: "alex@example.com",
};

function request(body: Record<string, unknown>, query = "portal=resident&targetListingId=listing-1") {
  return new Request(`https://prop-lane.test/api/agent/sms-test?${query}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveContext.mockResolvedValue(context);
  mocks.rateLimit.mockResolvedValue(null);
  mocks.serviceDb.mockReturnValue({ db: true });
  mocks.runTurn.mockResolvedValue({
    reply: "Available tomorrow.",
    toolTrace: [{ tool: "list_open_tour_slots", ok: true }],
    sessionId: "session-1",
    traceId: "trace-1",
    effects: [{ kind: "sms", status: "captured", summary: "Captured." }],
    mode: "prospect",
    stage: "prospect",
    target: context.target,
  });
});

describe("SMS test route authorization and session scope", () => {
  it("derives context from portal + target and ignores forged actor or manager body fields", async () => {
    const response = await POST(request({
      messages: [{ role: "user", content: "What times are open?" }],
      sessionId: "session-1",
      actorUserId: "forged-actor",
      managerUserId: "forged-manager",
      targetListingId: "forged-listing",
    }));

    expect(response.status).toBe(200);
    expect(mocks.resolveContext).toHaveBeenCalledWith({
      portal: "resident",
      targetListingId: "listing-1",
    });
    expect(mocks.runTurn).toHaveBeenCalledWith({
      context,
      message: "What times are open?",
      sessionId: "session-1",
    });
    expect(await response.json()).toMatchObject({
      reply: "Available tomorrow.",
      sessionId: "session-1",
      smsTest: {
        mode: "prospect",
        stage: "prospect",
        effects: [{ kind: "sms", status: "captured", summary: "Captured." }],
      },
    });
  });

  it("rejects unauthenticated/wrong-role context and direct action or attachment payloads", async () => {
    mocks.resolveContext.mockResolvedValueOnce(null);
    const unauthorized = await POST(request({ messages: [{ role: "user", content: "hello" }] }));
    expect(unauthorized.status).toBe(404);
    expect(mocks.runTurn).not.toHaveBeenCalled();

    for (const forbidden of [
      { confirmActionId: "action-1" },
      { denyActionId: "action-1" },
      { images: [{ url: "data:image/png;base64,AA==" }] },
      { documents: [{ name: "lease.pdf", url: "data:application/pdf;base64,AA==" }] },
    ]) {
      const response = await POST(request({
        messages: [{ role: "user", content: "YES" }],
        ...forbidden,
      }));
      expect(response.status).toBe(400);
    }
    expect(mocks.runTurn).not.toHaveBeenCalled();
  });

  it("accepts the empty attachment arrays sent by the shared chat composer", async () => {
    const response = await POST(request({
      messages: [{ role: "user", content: "What times are open?" }],
      images: [],
      documents: [],
    }));

    expect(response.status).toBe(200);
    expect(mocks.runTurn).toHaveBeenCalledOnce();
  });

  it("fails closed for a forged target or the production environment", async () => {
    mocks.resolveContext.mockResolvedValueOnce(null);
    const forgedTarget = await POST(request(
      { messages: [{ role: "user", content: "hello" }] },
      "portal=resident&targetListingId=forged-listing",
    ));
    expect(forgedTarget.status).toBe(404);
    expect(mocks.resolveContext).toHaveBeenLastCalledWith({
      portal: "resident",
      targetListingId: "forged-listing",
    });

    mocks.resolveContext.mockRejectedValueOnce(
      new Error("SMS test mode requires a non-production database."),
    );
    const production = await POST(request({
      messages: [{ role: "user", content: "hello" }],
    }));
    expect(production.status).toBe(404);
    expect(await production.json()).toEqual({ error: "Not found." });
    expect(mocks.runTurn).not.toHaveBeenCalled();
  });

  it("returns a context-change conflict for a stale or cross-target session", async () => {
    mocks.runTurn.mockRejectedValueOnce(new Error("The prospect SMS test session is invalid."));
    const response = await POST(request({
      messages: [{ role: "user", content: "continue" }],
      sessionId: "session-from-other-listing",
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "This SMS test context changed. Start a new test conversation to continue.",
    });
  });

  it("scopes history reads and deletes to exact kind, manager, mode, actor, and portal", async () => {
    mocks.history.mockResolvedValue(new Response("history", { status: 200 }));
    mocks.historyDelete.mockResolvedValue(new Response("deleted", { status: 200 }));
    const url = "https://prop-lane.test/api/agent/sms-test?portal=resident&targetListingId=listing-1";

    expect((await GET(new Request(url))).status).toBe(200);
    expect((await DELETE(new Request(url, { method: "DELETE" }))).status).toBe(200);
    const expectedActor = { userId: ACTOR, db: { db: true } };
    const expectedScope = {
      sessionKind: `leasing_sms_test:${MANAGER}:listing-1`,
      managerUserId: MANAGER,
      smsTestMode: "prospect",
    };
    expect(mocks.history).toHaveBeenCalledWith(expect.any(Request), expectedActor, "resident", expectedScope);
    expect(mocks.historyDelete).toHaveBeenCalledWith(expect.any(Request), expectedActor, "resident", expectedScope);
  });
});
