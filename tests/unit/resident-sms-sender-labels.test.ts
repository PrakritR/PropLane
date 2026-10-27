import { describe, expect, it } from "vitest";
import {
  ASSISTANT_SENDER_LABEL,
  decideOutboundSender,
  mergeSmsTurnsIntoRow,
  smsOnlyResidentRow,
  type ResidentCounterparty,
  type ResidentSmsConversation,
} from "@/lib/communication/resident-conversation";
import { loadResidentSmsConversations } from "@/lib/communication/resident-conversations.server";
import { MANAGER_SEND_DEDUPE_PREFIX } from "@/lib/sms/manager-send-dedupe";
import { inboxThreadMessages } from "@/lib/portal-inbox-storage";
import { createConversationFakeDb } from "../helpers/conversation-fake-db";

/**
 * Captain, Oct 27: in the resident's text conversation the assistant's replies were labelled with the workspace
 * owner's name ("Prakrit Ramachandran", "Aarav Jain"). An assistant or automated text says "PropLane"; a manager's own
 * typed reply keeps the manager's name. The evidence per turn: its projection `source_ref.source`, the outbox row that
 * carries its SID (`dedupe_key`: a person-typed send is `manager:...`), and the line it left on.
 */

const SHARED = "+12065551909";
const OWN_LINE = "+14084596787";
const RESIDENT_PHONE = "+14233423444";

describe("decideOutboundSender", () => {
  const none = { source: "work_number", outboxDedupeKey: null, fromPhone: OWN_LINE, propLaneNumbers: [SHARED] };

  it("a person-typed send (manager: key) is the manager's", () => {
    expect(decideOutboundSender({ ...none, outboxDedupeKey: `${MANAGER_SEND_DEDUPE_PREFIX}abc123` })).toBe("manager");
    // even when it left on a PropLane line: a person typed it in the inbox
    expect(decideOutboundSender({ ...none, fromPhone: SHARED, outboxDedupeKey: "manager:abc" })).toBe("manager");
  });

  it.each(["assistant_reply_sms_row1_hash_20261027", "shared-line:resident:1", "inbound_reply_msg9", "welcome:u1:a1:p1", "automation:k"])(
    "an outbox row with the key %s is the assistant's / an automation's",
    (key) => {
      expect(decideOutboundSender({ ...none, outboxDedupeKey: key })).toBe("assistant");
    },
  );

  it("an automated projection source is the assistant's whatever else is known", () => {
    expect(decideOutboundSender({ ...none, source: "automated", outboxDedupeKey: "manager:x" })).toBe("assistant");
  });

  it("a relay from the manager's own phone is the manager's", () => {
    expect(decideOutboundSender({ ...none, source: "relay" })).toBe("manager");
    expect(decideOutboundSender({ ...none, source: "relay", outboxDedupeKey: "something-else" })).toBe("manager");
  });

  it("with no outbox row, a text from a PropLane line is the assistant's and one from the manager's own number is theirs", () => {
    expect(decideOutboundSender({ ...none, fromPhone: SHARED })).toBe("assistant");
    expect(decideOutboundSender({ ...none, fromPhone: "(206) 555-1909" })).toBe("assistant");
    expect(decideOutboundSender({ ...none, fromPhone: OWN_LINE })).toBe("manager");
    expect(decideOutboundSender({ ...none, fromPhone: null })).toBe("manager");
    expect(decideOutboundSender({ ...none, fromPhone: SHARED, propLaneNumbers: [] })).toBe("manager");
  });
});

const counterparty: ResidentCounterparty = {
  workspaceId: "w1", name: "Aarav Jain", workspaceName: "My workspace", workPhone: OWN_LINE, avatarUrl: null, initials: "AJ",
};
function conversation(turns: ResidentSmsConversation["turns"]): ResidentSmsConversation {
  return { workspaceId: "w1", key: "ws:w1", counterparty, linkedBy: ["verified_phone"], turns, lastEventAt: turns[turns.length - 1]!.at };
}
const t = (id: string, direction: "inbound" | "outbound", at: string, sender?: "assistant" | "manager") => ({
  id, direction, body: `body ${id}`, at, fromPhone: direction === "inbound" ? RESIDENT_PHONE : OWN_LINE, toPhone: direction === "inbound" ? OWN_LINE : RESIDENT_PHONE, ...(sender ? { sender } : {}),
});

describe("the bubble label", () => {
  const turns = [
    t("a", "inbound", "2026-10-02T17:00:00Z"),
    t("b", "outbound", "2026-10-02T17:01:00Z", "assistant"),
    t("c", "outbound", "2026-10-02T17:30:00Z", "manager"),
    t("d", "outbound", "2026-10-02T17:40:00Z"), // a turn with no sender reads as the manager's (older stored shape)
  ];

  it("a text-only conversation labels the assistant 'PropLane' and the manager's own by name", () => {
    const row = smsOnlyResidentRow(conversation(turns), "Rita Resident")!;
    const messages = inboxThreadMessages(row);
    const from = (body: string) => messages.find((m) => m.body === body)!.from;
    expect(from("body a")).toBe("Aarav Jain"); // the resident's own text, drawn outbound: never labelled
    expect(from("body b")).toBe(ASSISTANT_SENDER_LABEL);
    expect(from("body b")).toBe("PropLane");
    expect(from("body c")).toBe("Aarav Jain");
    expect(from("body d")).toBe("Aarav Jain");
  });

  it("when the oldest text is the assistant's, the root bubble says PropLane but the conversation is still titled by the manager", () => {
    const row = smsOnlyResidentRow(
      conversation([t("b", "outbound", "2026-10-02T17:01:00Z", "assistant"), t("a", "inbound", "2026-10-02T17:05:00Z")]),
      "Rita Resident",
    )!;
    expect(row.from).toBe("Aarav Jain");
    expect(inboxThreadMessages(row).find((m) => m.body === "body b")!.from).toBe("PropLane");
  });

  it("merged into a stored row, the same labels apply", () => {
    const stored = smsOnlyResidentRow(conversation([t("a", "inbound", "2026-10-02T16:00:00Z")]), "Rita Resident")!;
    const merged = mergeSmsTurnsIntoRow(stored, conversation(turns), "Rita Resident");
    const names = inboxThreadMessages(merged).filter((m) => m.outbound !== true).map((m) => m.from);
    expect(names).toContain("PropLane");
    expect(names).toContain("Aarav Jain");
  });
});

describe("loadResidentSmsConversations marks each outbound turn", () => {
  const M = "11111111-0000-4000-8000-00000000000a";
  const R = "22222222-0000-4000-8000-00000000000b";
  const W = "aaaaaaaa-0000-4000-8000-0000000000a1";
  const LINE = "bbbbbbbb-0000-4000-8000-0000000000b1";
  const CONV = "cccccccc-0000-4000-8000-0000000000c1";
  const base = { conversation_id: CONV, owner_manager_user_id: M, from_phone: OWN_LINE, to_phone: RESIDENT_PHONE };

  function db(turns: Record<string, unknown>[], outbox: Record<string, unknown>[]) {
    return createConversationFakeDb({
      profiles: [
        { id: M, email: "m@x.co", full_name: "Aarav Jain", role: "manager" },
        { id: R, email: "r@x.co", full_name: "Rita Resident", phone: RESIDENT_PHONE, phone_verified_at: "2026-10-01T00:00:00Z", role: "resident" },
      ],
      portal_workspaces: [{ id: W, owner_user_id: M, name: "My workspace", is_default: true }],
      manager_sms_numbers: [{ id: LINE, workspace_id: W, manager_user_id: M, phone_number: OWN_LINE, provision_state: "active" }],
      manager_property_records: [{ id: "H1", manager_user_id: M, workspace_id: W }],
      manager_application_records: [{ manager_user_id: M, resident_email: "r@x.co", property_id: "H1", row_data: { bucket: "approved" } }],
      account_link_invites: [],
      portal_lease_pipeline_records: [],
      manager_vendor_records: [],
      portal_inbox_thread_records: [],
      sms_projection_conversations: [
        { id: CONV, owner_manager_user_id: M, counterparty_role: "resident", work_line_id: LINE, counterparty_user_id: R, counterparty_phone: RESIDENT_PHONE, workspace_id: W, merged_into_id: null },
      ],
      sms_projection_turns: turns,
      sms_outbox: outbox,
    });
  }

  it("reads who sent each text from its outbox row and the projection source", async () => {
    const turns = [
      { ...base, id: "t1", direction: "inbound", body: "hi", occurred_at: "2026-10-02T10:00:00Z", from_phone: RESIDENT_PHONE, to_phone: OWN_LINE, source_event_id: "SM1", source_ref: {} },
      { ...base, id: "t2", direction: "outbound", body: "assistant reply", occurred_at: "2026-10-02T10:01:00Z", source_event_id: "SM2", source_ref: { table: "manager_sms_messages", source: "work_number" } },
      { ...base, id: "t3", direction: "outbound", body: "typed by Aarav", occurred_at: "2026-10-02T10:30:00Z", source_event_id: "SM3", source_ref: { table: "manager_sms_messages", source: "work_number" } },
      { ...base, id: "t4", direction: "outbound", body: "bot", occurred_at: "2026-10-02T10:40:00Z", source_event_id: "SM4", source_ref: { table: "manager_sms_messages", source: "automated" } },
    ];
    const outbox = [
      { provider_message_sid: "SM2", dedupe_key: "assistant_reply_sms_row_hash_20261027", manager_user_id: M },
      { provider_message_sid: "SM3", dedupe_key: "manager:0123456789abcdef", manager_user_id: M },
    ];
    const { conversations } = await loadResidentSmsConversations(db(turns, outbox), R);
    const bySid = Object.fromEntries(conversations[0]!.turns.map((turn) => [turn.id, turn.sender]));
    expect(bySid).toEqual({ t1: undefined, t2: "assistant", t3: "manager", t4: "assistant" });
    const messages = inboxThreadMessages(smsOnlyResidentRow(conversations[0]!, "Rita Resident")!);
    expect(messages.find((m) => m.body === "assistant reply")!.from).toBe("PropLane");
    expect(messages.find((m) => m.body === "typed by Aarav")!.from).toBe("Aarav Jain");
  });

  it("never reads more than a key from the outbox, and a failed outbox read still labels from the line", async () => {
    const turns = [
      { ...base, id: "t2", direction: "outbound", body: "from own number", occurred_at: "2026-10-02T10:01:00Z", source_event_id: "SM2", source_ref: { source: "work_number" } },
    ];
    const { conversations } = await loadResidentSmsConversations(db(turns, []), R);
    // No outbox row, sent from the manager's own number: the manager's.
    expect(conversations[0]!.turns[0]!.sender).toBe("manager");
    expect(JSON.stringify(conversations[0]!.turns)).not.toContain("dedupe");
  });
});
