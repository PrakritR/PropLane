import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
vi.mock("server-only", () => ({}));
import { resolveApplicantScreeningSettings } from "@/lib/screening/applicant-screening-settings.server";

function fakeDb(tables: Record<string, Record<string, unknown> | null>) {
  return {
    from: (table: string) => {
      const chain: { select: () => typeof chain; eq: () => typeof chain; maybeSingle: () => Promise<{ data: unknown; error: null }> } = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: tables[table] ?? null, error: null }),
      };
      return chain;
    },
  } as unknown as SupabaseClient;
}

describe("applicant screening settings resolution", () => {
  it("defaults OFF even for a PropLane-managed workspace", async () => {
    const db = fakeDb({ portal_workspaces: { is_service: true }, workspace_automation_settings: null });
    const result = await resolveApplicantScreeningSettings(db, { managerUserId: "m", workspaceId: "ws-1" });
    expect(result.managed).toBe(true);
    expect(result.settings).toEqual({ idCheck: false, backgroundCheck: false, idUnlock: "clear" });
  });

  it("defaults OFF for a self-serve workspace and when nothing can be read", async () => {
    const selfServe = fakeDb({ portal_workspaces: { is_service: false }, workspace_automation_settings: null });
    expect((await resolveApplicantScreeningSettings(selfServe, { managerUserId: "m", workspaceId: "ws-1" })).settings).toEqual({ idCheck: false, backgroundCheck: false, idUnlock: "clear" });
    const noWorkspace = fakeDb({});
    expect((await resolveApplicantScreeningSettings(noWorkspace, { managerUserId: "m" })).settings).toEqual({ idCheck: false, backgroundCheck: false, idUnlock: "clear" });
  });

  it("a workspace's saved choice beats the default, per check", async () => {
    const db = fakeDb({ portal_workspaces: { is_service: true }, workspace_automation_settings: { row_data: { applicantScreening: { idCheck: false, backgroundCheck: true } } } });
    const result = await resolveApplicantScreeningSettings(db, { managerUserId: "m", workspaceId: "ws-1" });
    expect(result.source).toBe("workspace");
    expect(result.settings).toEqual({ idCheck: false, backgroundCheck: true, idUnlock: "clear" });
  });
});
