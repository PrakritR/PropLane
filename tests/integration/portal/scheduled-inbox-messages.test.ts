import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest, parseJsonResponse } from "../../helpers/api-request";

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: vi.fn(),
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: vi.fn(),
}));

vi.mock("@/lib/scheduled-inbox-messages.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/scheduled-inbox-messages.server")>();
  return {
    ...actual,
    updateScheduledInboxMessage: vi.fn(),
    updateScheduledInboxMessageForResident: vi.fn(),
  };
});

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import {
  RESIDENT_SCHEDULED_MESSAGE_CONTENT_FORBIDDEN,
  updateScheduledInboxMessage,
} from "@/lib/scheduled-inbox-messages.server";
import { PATCH } from "@/app/api/portal/scheduled-inbox-messages/[id]/route";

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

describe("PATCH /api/portal/scheduled-inbox-messages/[id]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 403 when a manager tries to edit resident-scheduled content", async () => {
    mockManagerAuth();
    vi.mocked(updateScheduledInboxMessage).mockRejectedValue(
      new Error(RESIDENT_SCHEDULED_MESSAGE_CONTENT_FORBIDDEN),
    );

    const req = jsonRequest("http://localhost/api/portal/scheduled-inbox-messages/sched_1", {
      method: "PATCH",
      body: { subject: "Forged" },
    });
    const res = await PATCH(req, { params: Promise.resolve({ id: "sched_1" }) });
    expect(res.status).toBe(403);
    const { data: body } = await parseJsonResponse<{ error: string }>(res);
    expect(body.error).toBe(RESIDENT_SCHEDULED_MESSAGE_CONTENT_FORBIDDEN);
  });
});
