import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentContext } from "@/lib/tools/context";

const { notifyManagerFromAgent } = vi.hoisted(() => ({ notifyManagerFromAgent: vi.fn() }));
vi.mock("@/lib/agent-notify.server", () => ({ notifyManagerFromAgent }));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));

import { escalateLeasingToManagerTool } from "@/lib/tools/domains/leasing-sms";

describe("leasing escalation delivery idempotency", () => {
  beforeEach(() => notifyManagerFromAgent.mockReset());

  it("does not turn a failed notification attempt into already-escalated success", async () => {
    const auditInsert = vi.fn(async () => ({ error: null }));
    const auditUpdateEq = vi.fn(async () => ({ error: null }));
    const auditUpdate = vi.fn((value: unknown) => ({ eq: (...args: unknown[]) => auditUpdateEq(value, ...args) }));
    const sessionEq = vi.fn();
    const sessionUpdate = vi.fn(() => ({
      eq: (...first: unknown[]) => ({
        eq: (...second: unknown[]) => {
          sessionEq(first, second);
          return Promise.resolve({ error: null });
        },
      }),
    }));
    const db = {
      from: (table: string) => {
        if (table === "audit_log") return { insert: auditInsert, update: auditUpdate };
        if (table === "agent_sessions") return { update: sessionUpdate };
        throw new Error(`unexpected table ${table}`);
      },
    } as unknown as AgentContext["db"];
    const ctx = {
      landlordId: "manager-a",
      userId: "manager-a",
      email: "",
      roles: ["leasing_sms_agent"],
      isAdmin: false,
      db,
      leasingScope: {
        sessionId: "session-a",
        prospectPhoneE164: "+12065550123",
        workNumber: "+12065550999",
      },
    } as AgentContext;

    notifyManagerFromAgent.mockRejectedValueOnce(new Error("delivery failed"));
    await expect(escalateLeasingToManagerTool.handler(ctx, { summary: "Needs a manager." }))
      .resolves.toMatchObject({ ok: false, error: "delivery failed" });
    expect(auditInsert).toHaveBeenCalledTimes(1);
    expect(auditUpdate).toHaveBeenCalledWith(expect.objectContaining({
      result_summary: { deliveryStatus: "failed" },
      dedupe_key: null,
    }));

    notifyManagerFromAgent.mockResolvedValueOnce({ delivered: true, suppressed: false });
    await expect(escalateLeasingToManagerTool.handler(ctx, { summary: "Needs a manager." }))
      .resolves.toMatchObject({ ok: true });
    expect(auditInsert).toHaveBeenCalledTimes(2);
    expect(auditUpdate).toHaveBeenLastCalledWith(expect.objectContaining({
      result_summary: { deliveryStatus: "delivered" },
    }));
    expect(notifyManagerFromAgent).toHaveBeenLastCalledWith(db, expect.objectContaining({
      idempotencyKey: expect.stringMatching(/^leasing_sms_escalate:/),
    }));
    expect(sessionEq).toHaveBeenCalledWith(
      ["id", "session-a"],
      ["landlord_id", "manager-a"],
    );
  });

  it("preserves a suppressed notification outcome across retries", async () => {
    let auditRecorded = true;
    let resultSummary: { deliveryStatus?: string } = { deliveryStatus: "pending" };
    const auditInsert = vi.fn(async () => auditRecorded
      ? { error: null }
      : { error: { code: "23505" } });
    const auditUpdate = vi.fn((value: { result_summary?: { deliveryStatus?: string } }) => ({
      eq: async () => {
        if (value.result_summary) resultSummary = value.result_summary;
        return { error: null };
      },
    }));
    const maybeSingle = vi.fn(async () => ({ data: { result_summary: resultSummary }, error: null }));
    const db = {
      from: (table: string) => {
        if (table === "audit_log") return {
          insert: auditInsert,
          update: auditUpdate,
          select: () => ({ eq: () => ({ maybeSingle }) }),
        };
        if (table === "agent_sessions") return { update: vi.fn() };
        throw new Error(`unexpected table ${table}`);
      },
    } as unknown as AgentContext["db"];
    const ctx = {
      landlordId: "manager-a",
      userId: "manager-a",
      email: "",
      roles: ["leasing_sms_agent"],
      isAdmin: false,
      db,
      leasingScope: {
        sessionId: "session-a",
        prospectPhoneE164: "+12065550123",
        workNumber: "+12065550999",
      },
    } as AgentContext;

    notifyManagerFromAgent.mockResolvedValue({ delivered: false, suppressed: true });
    await expect(escalateLeasingToManagerTool.handler(ctx, { summary: "Needs a manager." }))
      .resolves.toMatchObject({ ok: false, suppressed: true });
    expect(auditUpdate).toHaveBeenCalledWith(expect.objectContaining({
      result_summary: { deliveryStatus: "suppressed" },
    }));

    auditRecorded = false;
    await expect(escalateLeasingToManagerTool.handler(ctx, { summary: "Needs a manager." }))
      .resolves.toMatchObject({ ok: false, suppressed: true });
    expect(notifyManagerFromAgent).toHaveBeenCalledTimes(1);
  });
});
