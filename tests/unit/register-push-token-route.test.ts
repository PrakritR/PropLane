import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

/**
 * S12: a device push token survived sign-out, so the next person on a shared
 * phone's notifications kept fanning out to the previous account. Sign-out now
 * releases the token (only the caller's own).
 */
const state = vi.hoisted(() => ({ db: null as unknown, user: { id: "user-1" } as { id: string } | null }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: state.user } }) } }),
}));
vi.mock("@/lib/supabase/service", () => ({ createSupabaseServiceRoleClient: () => state.db }));

import { DELETE } from "@/app/api/native/register-push-token/route";

const tokens = () => (state.db as { __tables: Record<string, Record<string, unknown>[]> }).__tables.device_push_tokens;
const del = (body: unknown) =>
  DELETE(new Request("https://example.test/api/native/register-push-token", { method: "DELETE", body: JSON.stringify(body) }));

beforeEach(() => {
  state.user = { id: "user-1" };
  state.db = createMemoryDb({
    device_push_tokens: [
      { token: "tok-mine", user_id: "user-1", platform: "ios", disabled_at: null },
      { token: "tok-theirs", user_id: "user-2", platform: "ios", disabled_at: null },
    ],
  });
});

describe("DELETE /api/native/register-push-token", () => {
  it("disables the caller's own token on sign-out", async () => {
    const res = await del({ token: "tok-mine" });
    expect(res.status).toBe(200);
    expect(tokens().find((t) => t.token === "tok-mine")?.disabled_at).toBeTruthy();
  });

  it("never touches another account's token", async () => {
    await del({ token: "tok-theirs" });
    expect(tokens().find((t) => t.token === "tok-theirs")?.disabled_at).toBeNull();
  });

  it("requires a session", async () => {
    state.user = null;
    expect((await del({ token: "tok-mine" })).status).toBe(401);
  });
});
