import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadWorkspacePaymentSettings, saveWorkspacePaymentSettings } from "@/lib/workspace-payment-settings.server";

function fakeDb(settings: Record<string, unknown>) {
  const update = vi.fn();
  const eq = vi.fn();
  const query = {
    select: vi.fn(() => query),
    eq: vi.fn((...args: unknown[]) => { eq(...args); return query; }),
    maybeSingle: vi.fn(async () => ({ data: { payment_settings: settings }, error: null })),
    update: vi.fn((value: unknown) => { update(value); return query; }),
    then: (resolve: (value: unknown) => unknown) => Promise.resolve(resolve({ data: [{ id: "workspace", payment_settings: settings }], error: null })),
  };
  return { db: { from: vi.fn(() => query) } as unknown as SupabaseClient, update, eq };
}

describe("workspace payment preferences", () => {
  it("keeps autopay and coverage unchanged when changing only the default funding rail", async () => {
    const { db, update, eq } = fakeDb({ serviceFeePayer: "proplane", serviceFeeWaiverCode: "PRIVATE", autopayEnabled: false });
    expect(await saveWorkspacePaymentSettings(db, "owner", "workspace", { defaultPaymentMethod: "ach" })).toEqual({ saved: true });
    expect(update).toHaveBeenCalledWith({ payment_settings: { serviceFeePayer: "proplane", serviceFeeWaiverCode: "PRIVATE", autopayEnabled: false, defaultPaymentMethod: "ach" } });
    expect(eq).toHaveBeenCalledWith("owner_user_id", "owner");
    expect(eq).toHaveBeenCalledWith("id", "workspace");
  });
  it("does not erase the saved rail when another setting changes", async () => {
    const { db, update } = fakeDb({ defaultPaymentMethod: "ach", autopayEnabled: true });
    await saveWorkspacePaymentSettings(db, "owner", "workspace", { autopayRetryEnabled: false });
    expect(update).toHaveBeenCalledWith({ payment_settings: { defaultPaymentMethod: "ach", autopayEnabled: true, autopayRetryEnabled: false } });
  });
  it("does not accept arbitrary rails from stored settings", async () => {
    const { db } = fakeDb({ defaultPaymentMethod: "wire" });
    expect((await loadWorkspacePaymentSettings(db, "owner")).workspace.defaultPaymentMethod).toBeUndefined();
  });
});
