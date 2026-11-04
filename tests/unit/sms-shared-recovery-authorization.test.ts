import { describe, expect, it, vi } from "vitest";

const adminContinuation = vi.hoisted(() => vi.fn(async (): Promise<{ owned: { managerId: string; workspaceId: string } } | null> => null));
vi.mock("@/lib/one-number/inbound-seam.server", () => ({ adminAssistantContinuation: adminContinuation }));

const configState = vi.hoisted(() => ({
  result: { ok: true, config: { mode: "shared", sharedNumber: "+12065550100", messagingServiceSid: null, pilotWorkspaceIds: [] as string[], dedicatedWorkspaceIds: [] as string[] } } as { ok: false } | { ok: true; config: { mode: string; sharedNumber: string; messagingServiceSid: null; pilotWorkspaceIds: string[]; dedicatedWorkspaceIds: string[] } },
}));
vi.mock("@/lib/one-number/config.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/one-number/config.server")>()),
  loadSharedLineConfigStrict: vi.fn(async () => configState.result),
}));

import { authorizeSharedInboundRecovery, type InboundPayload } from "@/lib/sms/inbound-pipeline.server";

const payload: InboundPayload = { fromPhone: "+12065550200", toPhone: "+12065550100", body: "Hello", workspaceId: "ambika", media: {}, runtime: "development", sharedLine: true };
const config = () => ({ mode: "shared", sharedNumber: "+12065550100", messagingServiceSid: null, pilotWorkspaceIds: [] as string[], dedicatedWorkspaceIds: [] as string[] });
function db(rows: Record<string, { owner_user_id: string; archived_at: string | null }>, error = false) {
  return { from: () => ({ select: () => ({ eq: (_: string, id: string) => ({ maybeSingle: async () => ({ data: rows[id] ?? null, error: error ? { message: "unavailable" } : null }) }) }) }) } as never;
}
const rows = { ambika: { owner_user_id: "ambika-owner", archived_at: null }, vinod: { owner_user_id: "vinod-owner", archived_at: null } };

describe("shared inbound recovery authorization", () => {
  it("keeps each routed workspace's owner even when both use the same line", async () => {
    configState.result = { ok: true, config: config() };
    await expect(authorizeSharedInboundRecovery(db(rows), payload, "ambika-owner")).resolves.toBe("authorized");
    await expect(authorizeSharedInboundRecovery(db(rows), { ...payload, workspaceId: "vinod" }, "vinod-owner")).resolves.toBe("authorized");
    await expect(authorizeSharedInboundRecovery(db(rows), payload, "vinod-owner")).resolves.toBe("revoked");
  });
  it("revokes missing or archived workspaces", async () => {
    configState.result = { ok: true, config: config() };
    await expect(authorizeSharedInboundRecovery(db({}), payload, "ambika-owner")).resolves.toBe("revoked");
    await expect(authorizeSharedInboundRecovery(db({ ambika: { ...rows.ambika, archived_at: "2026-10-31" } }), payload, "ambika-owner")).resolves.toBe("revoked");
  });
  it.each([
        ["mode", { mode: "per_workspace" }],
    ["number", { sharedNumber: "+12065550999" }],
  ])("revokes when %s changes", async (_, changes) => {
    configState.result = { ok: true, config: { ...config(), ...changes } };
    await expect(authorizeSharedInboundRecovery(db(rows), payload, "ambika-owner")).resolves.toBe("revoked");
  });
  it.each([
    ["dedicated", { dedicatedWorkspaceIds: ["ambika"] }],
    ["pilot", { pilotWorkspaceIds: ["vinod"] }],
  ])("retries when %s eligibility changes because an admin continuation may be valid", async (_, changes) => {
    configState.result = { ok: true, config: { ...config(), ...changes } };
    await expect(authorizeSharedInboundRecovery(db(rows), payload, "ambika-owner")).resolves.toBe("unreadable");
  });
  it("authorizes an original admin continuation only for its same owner and workspace", async () => {
    configState.result = { ok: true, config: { ...config(), pilotWorkspaceIds: ["vinod"] } };
    adminContinuation.mockResolvedValueOnce({ owned: { managerId: "ambika-owner", workspaceId: "ambika" } });
    await expect(authorizeSharedInboundRecovery(db(rows), payload, "ambika-owner")).resolves.toBe("authorized");
    adminContinuation.mockResolvedValueOnce({ owned: { managerId: "vinod-owner", workspaceId: "vinod" } });
    await expect(authorizeSharedInboundRecovery(db(rows), payload, "ambika-owner")).resolves.toBe("unreadable");
  });
  it("retries unreadable configuration or workspace", async () => {
    configState.result = { ok: false };
    await expect(authorizeSharedInboundRecovery(db(rows), payload, "ambika-owner")).resolves.toBe("unreadable");
    configState.result = { ok: true, config: config() };
    await expect(authorizeSharedInboundRecovery(db(rows, true), payload, "ambika-owner")).resolves.toBe("unreadable");
  });
});
