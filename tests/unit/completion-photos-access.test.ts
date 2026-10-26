import { beforeEach, describe, expect, it, vi } from "vitest";

let access: { kind: string } = { kind: "allowed" };
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: { id: "u1" } } }) } }),
}));
const maybeSingle = vi.fn(async () => ({ data: { manager_user_id: "u1", vendor_user_id: null, row_data: { completionPhotoPaths: [] } } }));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle }) }) }) }),
}));
vi.mock("@/lib/test-workspaces/index.server", () => ({ resolveAuthenticatedBusinessAccess: async () => access }));
vi.mock("@/lib/completion-photo-storage.server", () => ({
  signCompletionPhotoPaths: async () => [],
  COMPLETION_PHOTO_SIGNED_URL_TTL_SECONDS: 600,
}));

import { GET } from "@/app/api/portal/work-orders/completion-photos/route";

const call = () => GET(new Request("http://x/api/portal/work-orders/completion-photos?workOrderId=w1"));

describe("completion-photos business access", () => {
  beforeEach(() => maybeSingle.mockClear());

  it("denied access is 401 and the work order is never read", async () => {
    access = { kind: "denied" };
    expect((await call()).status).toBe(401);
    expect(maybeSingle).not.toHaveBeenCalled();
  });

  it("allowed access reaches the owner check, and says when the signed urls expire", async () => {
    access = { kind: "allowed" };
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ urls: [], expiresInSeconds: 600 });
  });
});
