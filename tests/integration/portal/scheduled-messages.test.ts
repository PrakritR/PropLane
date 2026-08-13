import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest, parseJsonResponse } from "../../helpers/api-request";
import { DEFAULT_MANAGER_AUTOMATION_SETTINGS } from "@/lib/payment-automation-settings";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(),
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: vi.fn(),
}));

vi.mock("@/lib/payment-automation-server", () => ({
  loadManagerScheduledMessages: vi.fn(),
  parseScheduledMessageListId: vi.fn(),
}));

vi.mock("@/lib/payment-automation-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/payment-automation-settings")>();
  return {
    ...actual,
    upsertScheduledMessageOverride: vi.fn(),
  };
});

vi.mock("@/lib/scheduled-inbox-messages", () => ({
  updateScheduledInboxMessage: vi.fn(),
}));

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import {
  loadManagerScheduledMessages,
  parseScheduledMessageListId,
} from "@/lib/payment-automation-server";
import { upsertScheduledMessageOverride } from "@/lib/payment-automation-settings";
import { updateScheduledInboxMessage } from "@/lib/scheduled-inbox-messages";
import { GET } from "@/app/api/portal/scheduled-messages/route";
import { PATCH } from "@/app/api/portal/scheduled-messages/[id]/route";
import { encodeScheduledMessagePathId } from "@/lib/scheduled-message-path-id";

const SAMPLE_ID = "sched|charge-1|pre_due|3|2026-07-01";
const PATH_ID = encodeScheduledMessagePathId(SAMPLE_ID);
const TOUR_INBOX_ID = "sched_inbox_123_abc";

function mockManagerAuth(userId = "mgr-a") {
  vi.mocked(createSupabaseServerClient).mockResolvedValue({
    auth: {
      getUser: vi.fn().mockResolvedValue({
        data: { user: { id: userId, email: "mgr@test.com" } },
      }),
    },
  } as never);

  const profileChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data: { role: "manager" } }),
  };
  const rolesChain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockResolvedValue({ data: [{ role: "manager" }] }),
  };

  vi.mocked(createSupabaseServiceRoleClient).mockReturnValue({
    from: vi.fn((table: string) => {
      if (table === "profiles") return profileChain;
      if (table === "profile_roles") return rolesChain;
      throw new Error(`Unexpected table ${table}`);
    }),
  } as never);
}

describe("/api/portal/scheduled-messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadManagerScheduledMessages).mockResolvedValue({
      settings: DEFAULT_MANAGER_AUTOMATION_SETTINGS,
      messages: [],
    });
    vi.mocked(parseScheduledMessageListId).mockReturnValue({
      chargeId: "charge-1",
      kind: "pre_due",
      daysBeforeDue: 3,
    });
    vi.mocked(upsertScheduledMessageOverride).mockResolvedValue(undefined);
    vi.mocked(updateScheduledInboxMessage).mockResolvedValue(undefined);
  });

  it("GET returns 401 when unauthenticated", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    } as never);

    const req = new Request("http://localhost/api/portal/scheduled-messages");
    const res = await GET(req);
    const { status } = await parseJsonResponse(res);
    expect(status).toBe(401);
  });

  it("GET returns projected schedule for manager", async () => {
    mockManagerAuth();
    vi.mocked(loadManagerScheduledMessages).mockResolvedValue({
      settings: DEFAULT_MANAGER_AUTOMATION_SETTINGS,
      messages: [
        {
          id: "sched|charge-1|pre_due|3|2026-07-01",
          chargeId: "charge-1",
          kind: "pre_due",
          daysBeforeDue: 3,
          status: "scheduled",
        },
      ] as never,
    });

    const req = new Request("http://localhost/api/portal/scheduled-messages");
    const res = await GET(req);
    const { status, data } = await parseJsonResponse<{ messages?: { id: string }[] }>(res);
    expect(status).toBe(200);
    expect(data.messages).toHaveLength(1);
    expect(loadManagerScheduledMessages).toHaveBeenCalledWith(expect.anything(), "mgr-a", { includeHidden: false });
  });

  it("PATCH returns 401 when unauthenticated", async () => {
    vi.mocked(createSupabaseServerClient).mockResolvedValue({
      auth: { getUser: vi.fn().mockResolvedValue({ data: { user: null } }) },
    } as never);

    const req = jsonRequest(`http://localhost/api/portal/scheduled-messages/${PATH_ID}`, {
      method: "PATCH",
      body: { cancelled: true },
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: PATH_ID }) });
    const { status } = await parseJsonResponse(res);
    expect(status).toBe(401);
  });

  it("PATCH saves override for authenticated manager", async () => {
    mockManagerAuth();

    const req = jsonRequest(`http://localhost/api/portal/scheduled-messages/${PATH_ID}`, {
      method: "PATCH",
      body: { cancelled: true, customSubject: "Custom subject" },
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: PATH_ID }) });
    const { status, data } = await parseJsonResponse<{ ok?: boolean }>(res);
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(upsertScheduledMessageOverride).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        managerUserId: "mgr-a",
        chargeId: "charge-1",
        kind: "pre_due",
        daysBeforeDue: 3,
        patch: { cancelled: true, customSubject: "Custom subject" },
      }),
    );
  });

  it("PATCH updates tour inbox scheduled messages by sched_inbox id", async () => {
    mockManagerAuth();

    const req = jsonRequest(`http://localhost/api/portal/scheduled-messages/${TOUR_INBOX_ID}`, {
      method: "PATCH",
      body: { cancelled: true, customSubject: "Tour subject", customBody: "Tour body" },
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: TOUR_INBOX_ID }) });
    const { status, data } = await parseJsonResponse<{ ok?: boolean }>(res);
    expect(status).toBe(200);
    expect(data.ok).toBe(true);
    expect(updateScheduledInboxMessage).toHaveBeenCalledWith(
      expect.anything(),
      "mgr-a",
      TOUR_INBOX_ID,
      expect.objectContaining({
        status: "cancelled",
        subject: "Tour subject",
        body: "Tour body",
      }),
    );
    expect(upsertScheduledMessageOverride).not.toHaveBeenCalled();
  });

  it("PATCH returns 400 for invalid message id", async () => {
    mockManagerAuth();
    vi.mocked(parseScheduledMessageListId).mockReturnValue(null);

    const req = jsonRequest("http://localhost/api/portal/scheduled-messages/bad-id", {
      method: "PATCH",
      body: { cancelled: true },
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: "bad-id" }) });
    const { status } = await parseJsonResponse(res);
    expect(status).toBe(400);
  });
});
