import { describe, expect, it } from "vitest";
import { projectOriginalEvent } from "@/lib/sms/sms-projection.server";
import { createConversationFakeDb } from "../helpers/conversation-fake-db";

/**
 * A text conversation joins its person's conversation key: stamped on the
 * projection summary the first time the conversation exists, in the workspace
 * that owns the work line, as the account that VERIFIED the phone (never an
 * unverified one).
 */

const M = "11111111-0000-4000-8000-00000000000a";
const R = "22222222-0000-4000-8000-00000000000b";
const W1 = "aaaaaaaa-0000-4000-8000-0000000000a1";
const LINE = "bbbbbbbb-0000-4000-8000-0000000000b1";

function dbWith(profile: Record<string, unknown>) {
  const db = createConversationFakeDb({
    manager_sms_numbers: [{ id: LINE, workspace_id: W1, phone_number: "+12065550100" }],
    portal_workspaces: [{ id: W1, owner_user_id: M, is_default: true }],
    profiles: [{ id: R, email: "r@x.co", ...profile }],
    manager_application_records: [{ manager_user_id: M, resident_email: "r@x.co", property_id: "H1", row_data: {} }],
    manager_property_records: [{ id: "H1", manager_user_id: M, workspace_id: W1 }],
    account_link_invites: [],
    portal_lease_pipeline_records: [],
    manager_vendor_records: [],
  });
  const stamps: Record<string, unknown>[] = [];
  const base = db.rpc.bind(db);
  (db as unknown as { rpc: unknown }).rpc = (fn: string, args: Record<string, unknown>) => {
    if (fn === "project_sms_conversation_event") {
      return Promise.resolve({ data: { conversationId: "conv-1", turnId: "turn-1", inserted: true, eventCount: 1 }, error: null });
    }
    if (fn === "stamp_sms_projection_conversation") {
      stamps.push(args);
      return Promise.resolve({ data: true, error: null });
    }
    return base(fn, args);
  };
  return { db, stamps };
}

const event = {
  ownerManagerUserId: M,
  counterpartyRole: "resident" as const,
  workLineId: LINE,
  identityKey: "phone:+15105551234",
  identityKind: "phone" as const,
  counterpartyPhone: "+15105551234",
  sourceNamespace: "twilio",
  sourceEventId: "SM00000000000000000000000000000001",
  direction: "inbound" as const,
  body: "hi",
  occurredAt: "2026-10-03T10:00:00Z",
};

describe("SMS projection conversations carry the person-conversation key", () => {
  it("a text from a number its account verified is stamped with the account key, in the line's workspace", async () => {
    const { db, stamps } = dbWith({ phone: "+15105551234", phone_verified_at: "2026-09-01T00:00:00Z" });
    await projectOriginalEvent(db, event);
    expect(stamps).toEqual([{ p_conversation_id: "conv-1", p_workspace: W1, p_key: `acct:${R}` }]);
  });

  it("a text from a number NO account verified is a phone conversation, never an account's", async () => {
    const { db, stamps } = dbWith({ phone: "+15105551234", phone_verified_at: null });
    await projectOriginalEvent(db, event);
    expect(stamps).toEqual([{ p_conversation_id: "conv-1", p_workspace: W1, p_key: "tel:+15105551234" }]);
  });

  it("an existing conversation is not re-stamped on every later text", async () => {
    const { db, stamps } = dbWith({});
    const base = db.rpc;
    (db as unknown as { rpc: unknown }).rpc = (fn: string, args: Record<string, unknown>) =>
      fn === "project_sms_conversation_event"
        ? Promise.resolve({ data: { conversationId: "conv-1", turnId: "t2", inserted: true, eventCount: 7 }, error: null })
        : base(fn, args);
    await projectOriginalEvent(db, event);
    expect(stamps).toEqual([]);
  });

  it("a failure to stamp never fails the projection write", async () => {
    const { db } = dbWith({});
    const base = db.rpc;
    (db as unknown as { rpc: unknown }).rpc = (fn: string, args: Record<string, unknown>) =>
      fn === "stamp_sms_projection_conversation"
        ? Promise.reject(new Error("down"))
        : base(fn, args);
    await expect(projectOriginalEvent(db, event)).resolves.toMatchObject({ conversationId: "conv-1" });
  });
});
