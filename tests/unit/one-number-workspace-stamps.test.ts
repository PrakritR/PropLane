import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sms/project-manager-sms-event.server", () => ({ projectManagerSmsEvent: vi.fn(async () => true) }));

import { logManagerSmsMessage } from "@/lib/manager-sms-messages.server";
import { projectManagerSmsEvent } from "@/lib/sms/project-manager-sms-event.server";
import { upsertManagerSmsContact } from "@/lib/sms/manager-sms-contacts.server";

type Written = { table: string; row: Record<string, unknown> };

function writer(failFirstWithMissingColumn = false) {
  const writes: Written[] = [];
  let failed = false;
  return {
    writes,
    db: {
      from: (table: string) => {
        const q: Record<string, unknown> = {
          select: () => q, eq: () => q, limit: async () => ({ data: [], error: null }),
          insert: async (row: Record<string, unknown>) => {
            writes.push({ table, row });
            if (failFirstWithMissingColumn && !failed && "workspace_id" in row) { failed = true; return { error: { code: "42703", message: 'column "workspace_id" does not exist' } }; }
            return { error: null };
          },
          upsert: async (row: Record<string, unknown>) => { writes.push({ table, row }); return { error: null }; },
          maybeSingle: async () => ({ data: null, error: null }),
        };
        return q;
      },
    } as never,
  };
}

const message = { managerUserId: "owner-1", residentPhone: "+12065551234", direction: "inbound" as const, body: "hi", toPhone: "+12065550100", messageSid: "SM" + "a".repeat(32) };

describe("workspace stamps on SMS writes", () => {
  it("stamps manager_sms_messages and hands the workspace to the projection", async () => {
    const { db, writes } = writer();
    await logManagerSmsMessage(db, { ...message, workspaceId: "ws-1" });
    expect(writes.find((w) => w.table === "manager_sms_messages")?.row).toMatchObject({ workspace_id: "ws-1", manager_user_id: "owner-1" });
    expect(projectManagerSmsEvent).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ workspaceId: "ws-1" }));
  });

  it("writes the old row shape when no workspace is known", async () => {
    const { db, writes } = writer();
    await logManagerSmsMessage(db, message);
    expect(writes[0].row).not.toHaveProperty("workspace_id");
  });

  it("retries without the column when it has not been migrated yet", async () => {
    const { db, writes } = writer(true);
    await expect(logManagerSmsMessage(db, { ...message, messageSid: "SM" + "b".repeat(32), workspaceId: "ws-1" })).resolves.toBe(true);
    const inserts = writes.filter((w) => w.table === "manager_sms_messages");
    expect(inserts).toHaveLength(2);
    expect(inserts[0].row).toHaveProperty("workspace_id", "ws-1");
    expect(inserts[1].row).not.toHaveProperty("workspace_id");
  });

  it("stamps manager_sms_contacts", async () => {
    const { db, writes } = writer();
    await upsertManagerSmsContact(db, { managerUserId: "owner-1", phone: "+12065551234", counterpartyRole: "resident", workspaceId: "ws-1", lastInboundAt: "2026-10-18T10:00:00.000Z" });
    expect(writes[0]).toMatchObject({ table: "manager_sms_contacts", row: { workspace_id: "ws-1", manager_user_id: "owner-1" } });
  });
});
