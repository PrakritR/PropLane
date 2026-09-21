import { beforeEach, describe, expect, it, vi } from "vitest";

const classify = vi.hoisted(() => vi.fn());
const serviceDb = vi.hoisted(() => vi.fn());
vi.mock("@/lib/test-workspaces/index.server", () => ({
  resolveTestWorkspaceClassification: classify,
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: serviceDb }));

import {
  assertTestWorkspaceProviderEffectAllowed,
  captureTestWorkspaceEffectForUser,
  TestWorkspaceProviderDisabledError,
} from "@/lib/test-workspaces/effects.server";
import { postResendEmail } from "@/lib/resend-delivery.server";
import { sendSms } from "@/lib/twilio";
import { getGoogleCalendarAccessToken } from "@/lib/google-calendar/api.server";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const WORKSPACE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function auditDb() {
  const inserts: Record<string, unknown>[] = [];
  return {
    inserts,
    db: {
      from: vi.fn(() => ({
        insert: vi.fn(async (row: Record<string, unknown>) => { inserts.push(row); return { error: null }; }),
      })),
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  classify.mockResolvedValue({ kind: "classified", workspaceId: WORKSPACE, role: "resident", state: "active" });
  serviceDb.mockReturnValue(auditDb().db);
});

describe("workspace effect boundary outside SMS ALS", () => {
  it("records a classified worker effect durably after request-local context is gone", async () => {
    const { db, inserts } = auditDb();
    const result = await captureTestWorkspaceEffectForUser({
      userId: ACTOR,
      kind: "email",
      summary: "Delayed welcome email",
      db: db as never,
    });

    expect(result).toEqual({ captured: true, workspaceId: WORKSPACE });
    expect(inserts).toEqual([expect.objectContaining({
      action: "test_workspace_effect_captured",
      test_workspace_id: WORKSPACE,
    })]);
  });

  it("refuses a classified payment before a caller can create a customer or purchase row", async () => {
    const { db, inserts } = auditDb();
    await expect(assertTestWorkspaceProviderEffectAllowed({
      userId: ACTOR,
      kind: "payment",
      summary: "Stripe checkout",
      db: db as never,
    })).rejects.toBeInstanceOf(TestWorkspaceProviderDisabledError);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toMatchObject({
      action: "test_workspace_effect_captured",
      result_summary: { outcome: "refused" },
    });
  });

  it("allows an ordinary provider boundary without retaining a test effect", async () => {
    classify.mockResolvedValue({ kind: "normal" });
    const { db, inserts } = auditDb();
    await expect(assertTestWorkspaceProviderEffectAllowed({
      userId: ACTOR,
      kind: "calendar",
      summary: "Google Calendar read",
      db: db as never,
    })).resolves.toBeUndefined();
    expect(inserts).toHaveLength(0);
  });

  it("blocks a pre-existing Google connection before token refresh or event reads", async () => {
    const { db } = auditDb();
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(getGoogleCalendarAccessToken(db as never, ACTOR)).rejects.toBeInstanceOf(
      TestWorkspaceProviderDisabledError,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it("lets a normal provider call through when the actor is unclassified", async () => {
    classify.mockResolvedValue({ kind: "normal" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    const response = await postResendEmail({
      apiKey: "re_test",
      effectSummary: "Normal customer email",
      payload: { from: "PropLane <test@example.com>", to: ["customer@example.com"], subject: "Hello", text: "Hello" },
    });

    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledWith("https://api.resend.com/emails", expect.any(Object));
    fetchMock.mockRestore();
  });

  it("captures a classified provider email outside ALS using the trusted actor identity", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const response = await postResendEmail({
      apiKey: "re_test",
      actorUserId: ACTOR,
      effectSummary: "Delayed classified email",
      payload: { from: "PropLane <test@example.com>", to: ["resident@example.com"], subject: "Hello", text: "Hello" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("X-PropLane-Test-Workspace-Captured")).toBe("1");
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockRestore();
  });

  it("captures a classified low-level SMS outside ALS before Twilio construction", async () => {
    const result = await sendSms("+15551234567", "Test workspace message", "+15557654321", { actorUserId: ACTOR });

    expect(result).toEqual({ sent: true, sid: "test_workspace_captured" });
  });
});
