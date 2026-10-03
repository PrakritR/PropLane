import { describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

/**
 * S10 (comms-safety-0929): a co-manager with Communication EDIT on one house
 * could hard-delete any of the owner's stored texts by message id. Deleting is
 * a DELETE right, held on the message's own house.
 */

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

import { deleteManagerSmsMessage } from "@/lib/manager-sms-messages.server";

const OWNER = "owner-1";
const CO = "co-1";

function seed(inboxGrant: Record<string, boolean>) {
  return createMemoryDb({
    profiles: [
      { id: OWNER, email: "owner@example.test" },
      { id: CO, email: "co@example.test" },
    ],
    manager_property_records: [{ id: "h1", manager_user_id: OWNER, workspace_id: "w1", row_data: {} }],
    account_link_invites: [
      {
        id: "l1", status: "accepted", inviter_user_id: OWNER, invitee_user_id: CO, house_scope: "selected",
        assigned_property_ids: ["h1"], property_co_manager_permissions: { h1: { inbox: inboxGrant } },
      },
    ],
    manager_sms_messages: [{ id: "m1", manager_user_id: OWNER, resident_phone: "+12065550100", body: "private" }],
  });
}

const messages = (db: ReturnType<typeof seed>) => (db as unknown as { __tables: Record<string, unknown[]> }).__tables.manager_sms_messages;
const del = (db: ReturnType<typeof seed>, viewer: string) =>
  deleteManagerSmsMessage(db as never, { viewerUserId: viewer, messageId: "m1", storageTable: "manager_sms_messages" });

describe("deleteManagerSmsMessage (S10)", () => {
  it("refuses a co-manager who holds only EDIT on the owner's house", async () => {
    const db = seed({ read: true, edit: true });
    expect(await del(db, CO)).toMatchObject({ ok: false, error: "forbidden", status: 403 });
    expect(messages(db)).toHaveLength(1);
  });

  it("refuses a co-manager with DELETE on a house when the message is not in a conversation they can see there", async () => {
    const db = seed({ read: true, edit: true, delete: true });
    expect(await del(db, CO)).toMatchObject({ ok: false, error: "forbidden", status: 403 });
    expect(messages(db)).toHaveLength(1);
  });

  it("lets the owner delete their own text", async () => {
    const db = seed({});
    expect(await del(db, OWNER)).toEqual({ ok: true });
    expect(messages(db)).toHaveLength(0);
  });
});
