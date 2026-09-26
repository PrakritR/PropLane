import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const { project } = vi.hoisted(() => ({ project: vi.fn(async () => false) }));
vi.mock("@/lib/sms/project-manager-sms-event.server", () => ({ projectManagerSmsEvent: project }));

import { logManagerSmsMessage } from "@/lib/manager-sms-messages.server";

const input = {
  managerUserId: "owner-1", residentPhone: "+14155550123", direction: "inbound" as const,
  body: "The original text", fromPhone: "+14155550123", toPhone: "+14155550999",
  messageSid: "SM-original", createdAt: "2026-09-25T12:00:00.000Z",
  counterpartyRole: "prospect" as const,
};

beforeEach(() => project.mockClear());

describe("operational SMS logging gate", () => {
  it("keeps a durably stored inbound eligible for reply when its projection is deferred", async () => {
    const db = {
      from: () => {
        const q: Record<string, unknown> = {};
        q.select = () => q; q.eq = () => q;
        q.limit = async () => ({ data: [], error: null });
        q.insert = async () => ({ error: null });
        return q;
      },
    };
    await expect(logManagerSmsMessage(db as never, input)).resolves.toBe(true);
    expect(project).toHaveBeenCalledWith(db, expect.objectContaining({
      messageSid: "SM-original", body: "The original text", occurredAt: input.createdAt,
    }));
  });

  it("rereads a concurrent SID winner's original envelope before repair", async () => {
    const winner = {
      created_at: "2026-09-25T11:59:00.000Z", body: "Winning original",
      from_phone: "+14155550123", to_phone: "+14155550999",
    };
    let reads = 0;
    const db = {
      from: () => {
        const q: Record<string, unknown> = {};
        q.select = () => q; q.eq = () => q;
        q.limit = async () => ({ data: reads++ === 0 ? [] : [winner], error: null });
        q.maybeSingle = async () => ({ data: winner, error: null });
        q.insert = async () => ({ error: { code: "23505", message: "duplicate" } });
        return q;
      },
    };
    await expect(logManagerSmsMessage(db as never, { ...input, createdAt: null })).resolves.toBe(true);
    expect(project).toHaveBeenCalledWith(db, expect.objectContaining({
      body: "Winning original", occurredAt: winner.created_at,
    }));
  });
});
