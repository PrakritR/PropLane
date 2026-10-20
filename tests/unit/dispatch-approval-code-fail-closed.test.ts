// The dispatch approval-code gate decides whether a security control applies, so a read that FAILS must keep it on.
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/vendor-dispatch/engine.server", () => ({}));

import { checkDispatchApprovalCode, dispatchApprovalNeedsCode } from "@/lib/vendor-dispatch/approval-code.server";

const SERVICE_OWNER = "svc-owner";
type Tables = Record<string, Record<string, unknown>[] | { error: { code: string } }>;
function fakeDb(tables: Tables) {
  const from = (table: string) => {
    const source = tables[table];
    const rows = Array.isArray(source) ? source : [];
    const error = Array.isArray(source) ? null : source?.error ?? null;
    let filtered = rows;
    const chain: Record<string, unknown> = {
      select: () => chain,
      eq: (col: string, value: unknown) => { filtered = filtered.filter((r) => r[col] === value); return chain; },
      maybeSingle: async () => ({ data: error ? null : filtered[0] ?? null, error }),
    };
    return chain;
  };
  return { from } as never;
}
const RUN = { id: "run-1", owner_user_id: "mgr-1", workspace_id: "ws-1" };
const healthy = (): Tables => ({
  portal_workspaces: [{ id: "ws-1", is_service: false }],
  platform_service_settings: [{ singleton: true, owner_user_id: SERVICE_OWNER }],
});

describe("dispatchApprovalNeedsCode fails closed", () => {
  it("answers from the data when every read works", async () => {
    expect(await dispatchApprovalNeedsCode(fakeDb(healthy()), RUN)).toBe(false);
    expect(await dispatchApprovalNeedsCode(fakeDb({ ...healthy(), portal_workspaces: [{ id: "ws-1", is_service: true }] }), RUN)).toBe(true);
    expect(await dispatchApprovalNeedsCode(fakeDb(healthy()), { ...RUN, owner_user_id: SERVICE_OWNER })).toBe(true);
  });

  it("a failed workspace read requires the code, where it used to switch the gate off", async () => {
    expect(await dispatchApprovalNeedsCode(fakeDb({ ...healthy(), portal_workspaces: { error: { code: "500" } } }), RUN)).toBe(true);
  });

  it("a failed platform-owner read requires the code (a service workspace, and the owner comparison)", async () => {
    const down = { platform_service_settings: { error: { code: "500" } } } as Tables;
    expect(await dispatchApprovalNeedsCode(fakeDb({ ...healthy(), ...down }), RUN)).toBe(true);
    expect(await dispatchApprovalNeedsCode(fakeDb({ ...healthy(), portal_workspaces: [{ id: "ws-1", is_service: true }], ...down }), RUN)).toBe(true);
  });

  it("a thrown client error requires the code too", async () => {
    const exploding = { from: () => { throw new Error("boom"); } } as never;
    expect(await dispatchApprovalNeedsCode(exploding, RUN)).toBe(true);
  });

  it("so an answer on an unreadable run is never 'not_required'", async () => {
    const broken = fakeDb({ ...healthy(), portal_workspaces: { error: { code: "500" } } });
    expect(await checkDispatchApprovalCode(broken, RUN, "dispatch_approval", null)).toBe("wrong");
    expect(await checkDispatchApprovalCode(fakeDb(healthy()), RUN, "dispatch_approval", null)).toBe("not_required");
  });
});

describe("the per-phone lock reaches both answer paths", () => {
  it("the dispatch reply and the Assistant confirmation pass the texting phone and answer `locked` with the portal line", async () => {
    const { readFileSync } = await import("node:fs");
    const inbound = readFileSync("src/lib/vendor-dispatch/inbound.server.ts", "utf8");
    expect(inbound).toMatch(/checkDispatchApprovalCode\(db, run, codedKind, presentedCode, input\.fromPhone\)/);
    expect(inbound).toMatch(/checked === "locked"/);
    const turn = readFileSync("src/lib/agent/sms-agent-turn.server.ts", "utf8");
    expect(turn).toMatch(/code: typedCode, phone: args\.phoneE164/);
    expect(turn).toMatch(/checked === "locked"[\s\S]{0,80}SMS_CONFIRMATION_LOCKED_REPLY/);
    const pipeline = readFileSync("src/lib/sms/inbound-pipeline.server.ts", "utf8");
    expect(pipeline).toMatch(/body,\s*fromPhone,/);
  });
});
