import { describe, expect, it } from "vitest";
import { decideVendorSmsLink } from "@/lib/communication/vendor-conversation";
import {
  applyVendorConversationExtras,
  linkVerifiedVendorPhoneHistory,
  loadVendorSmsConversations,
} from "@/lib/communication/vendor-conversations.server";
import { VENDOR_SMS_ROW_PREFIX } from "@/lib/communication/resident-conversation";
import { isServerReservedInboxThreadId } from "@/lib/portal-inbox-thread-upsert";
import type { PersistedInboxThread } from "@/lib/portal-inbox-storage";
import { createConversationFakeDb, type FakeDb } from "../helpers/conversation-fake-db";

/**
 * Vendor texting (Oct 6): when a vendor creates a PropLane account and verifies
 * the phone with a code, every conversation their managers had with that number
 * shows in their Communication - one per manager workspace, earlier texts included.
 * Verified-only, ambiguity-safe, work-line scoped, vendor-role only.
 */

const M1 = "11111111-0000-4000-8000-00000000000a";
const M2 = "11111111-0000-4000-8000-00000000000b";
const V = "55555555-0000-4000-8000-00000000000e"; // the vendor's account
const OTHER = "66666666-0000-4000-8000-00000000000f";
const W1 = "aaaaaaaa-0000-4000-8000-0000000000a1";
const W2 = "aaaaaaaa-0000-4000-8000-0000000000a2";
const LINE1 = "bbbbbbbb-0000-4000-8000-0000000000b1";
const LINE2 = "bbbbbbbb-0000-4000-8000-0000000000b2";
const PHONE = "+14255550199";

type Seed = Record<string, Record<string, unknown>[]>;

function seededDb(extra: Seed = {}): FakeDb {
  return createConversationFakeDb({
    profiles: [
      { id: M1, email: "m1@x.co", full_name: "Sam Rivera", role: "manager" },
      { id: M2, email: "m2@x.co", full_name: "Jo Park", role: "manager" },
      { id: V, email: "mike@plumbing.test", full_name: "Mike", phone: PHONE, phone_verified_at: "2026-10-06T10:00:00Z", role: "vendor" },
    ],
    portal_workspaces: [
      { id: W1, owner_user_id: M1, name: "Alder Property Co", is_default: true },
      { id: W2, owner_user_id: M2, name: "Green Lake Rentals", is_default: true },
    ],
    manager_sms_numbers: [
      { id: LINE1, workspace_id: W1, manager_user_id: M1, phone_number: "+12065550101", provision_state: "active" },
      { id: LINE2, workspace_id: W2, manager_user_id: M2, phone_number: "+12065550102", provision_state: "active" },
    ],
    manager_property_records: [],
    manager_application_records: [],
    account_link_invites: [],
    portal_lease_pipeline_records: [],
    manager_vendor_records: [],
    portal_inbox_thread_records: [],
    sms_projection_conversations: [],
    sms_projection_turns: [],
    ...extra,
  });
}

let counter = 0;
function conversation(over: Record<string, unknown> = {}, turns: Record<string, unknown>[] = [{}]): Seed {
  counter += 1;
  const row = {
    id: `conv-${counter}`,
    owner_manager_user_id: M1,
    counterparty_role: "vendor",
    work_line_id: LINE1,
    counterparty_user_id: null,
    counterparty_phone: PHONE,
    workspace_id: W1,
    merged_into_id: null,
    ...over,
  };
  return {
    sms_projection_conversations: [row],
    sms_projection_turns: turns.map((t, index) => ({
      id: `turn-${counter}-${index}`,
      conversation_id: row.id,
      direction: "outbound",
      body: `text ${counter}-${index}`,
      occurred_at: `2026-10-02T10:0${index}:00Z`,
      from_phone: "+12065550101",
      to_phone: PHONE,
      ...t,
    })),
  };
}
const merge = (...seeds: Seed[]): Seed => {
  const out: Seed = {};
  for (const seed of seeds) for (const [table, rows] of Object.entries(seed)) (out[table] ??= []).push(...rows);
  return out;
};

describe("decideVendorSmsLink - which text conversations are a vendor's", () => {
  const base = { vendorId: V, verifiedPhone: PHONE, phoneVerifierIds: [V] };
  const row = { role: "vendor", counterpartyUserId: null as string | null, counterpartyPhone: PHONE };

  it("a verified phone only this account verified links a vendor conversation", () => {
    expect(decideVendorSmsLink({ ...base, row })).toBe("verified_phone");
  });

  it("an unverified or self-typed phone links nothing", () => {
    expect(decideVendorSmsLink({ ...base, verifiedPhone: null, phoneVerifierIds: [], row })).toBeNull();
  });

  it("a number a second account also verified links to neither", () => {
    expect(decideVendorSmsLink({ ...base, phoneVerifierIds: [V, OTHER], row })).toBeNull();
    expect(decideVendorSmsLink({ ...base, phoneVerifierIds: [OTHER], row })).toBeNull();
  });

  it("a conversation the pipeline resolved to another account is never this vendor's", () => {
    expect(decideVendorSmsLink({ ...base, row: { ...row, counterpartyUserId: OTHER } })).toBeNull();
    expect(decideVendorSmsLink({ ...base, verifiedPhone: null, phoneVerifierIds: [], row: { ...row, counterpartyUserId: V, counterpartyPhone: null } })).toBe("account");
  });

  it("only vendor conversations: a resident, prospect or manager thread on the same number never appears", () => {
    for (const role of ["resident", "prospect", "applicant", "manager", "admin", "unknown", "", undefined]) {
      expect(decideVendorSmsLink({ ...base, row: { ...row, role } })).toBeNull();
    }
  });

  it("formats of the same number match", () => {
    expect(decideVendorSmsLink({ ...base, row: { ...row, counterpartyPhone: "(425) 555-0199" } })).toBe("verified_phone");
  });
});

describe("loadVendorSmsConversations - one conversation per manager workspace", () => {
  it("returns each workspace's texts, with the manager named and the work number to text back", async () => {
    const db = seededDb(
      merge(
        conversation({}, [{ body: "Hi Mike, leak at 1420 Alder?" }, { direction: "inbound", body: "Yes, Thursday 10am", from_phone: PHONE, to_phone: "+12065550101" }]),
        conversation({ owner_manager_user_id: M2, work_line_id: LINE2, workspace_id: W2 }, [{ body: "Invoice received" }]),
      ),
    );
    const { conversations, phone } = await loadVendorSmsConversations(db, V);

    expect(phone).toEqual({ hasPhone: true, verified: true, ambiguous: false });
    expect(conversations.map((c) => c.workspaceId).sort()).toEqual([W1, W2].sort());
    const alder = conversations.find((c) => c.workspaceId === W1)!;
    expect(alder.key).toBe(`ws:${W1}`);
    expect(alder.counterparty).toMatchObject({ name: "Sam Rivera", workspaceName: "Alder Property Co", workPhone: "+12065550101" });
    expect(alder.turns.map((t) => t.body)).toEqual(["Hi Mike, leak at 1420 Alder?", "Yes, Thursday 10am"]);
  });

  it("two conversations on one work line fold into ONE workspace conversation", async () => {
    const db = seededDb(
      merge(
        conversation({ counterparty_phone: PHONE }, [{ body: "first" }]),
        conversation({ counterparty_user_id: V, counterparty_phone: null }, [{ body: "second", occurred_at: "2026-10-03T10:00:00Z" }]),
      ),
    );
    const { conversations } = await loadVendorSmsConversations(db, V);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]!.turns.map((t) => t.body)).toEqual(["first", "second"]);
  });

  it("a second account verifying the same number sees none of it - and neither does the first", async () => {
    const db = seededDb(conversation());
    db.tables.profiles!.push({ id: OTHER, email: "dup@x.co", phone: PHONE, phone_verified_at: "2026-10-06T11:00:00Z", role: "vendor" });

    expect((await loadVendorSmsConversations(db, OTHER)).conversations).toEqual([]);
    expect((await loadVendorSmsConversations(db, V)).conversations).toEqual([]);
  });

  it("an unverified phone, even a self-typed copy of the real number, links nothing", async () => {
    const db = seededDb(conversation());
    db.tables.profiles!.find((p) => p.id === V)!.phone_verified_at = null;
    const { conversations, phone } = await loadVendorSmsConversations(db, V);
    expect(conversations).toEqual([]);
    expect(phone).toEqual({ hasPhone: true, verified: false, ambiguous: false });
  });

  it("a resident or prospect conversation on the vendor's number is not read", async () => {
    const db = seededDb(merge(conversation({ counterparty_role: "prospect" }), conversation({ counterparty_role: "resident" })));
    expect((await loadVendorSmsConversations(db, V)).conversations).toEqual([]);
  });

  it("the workspace is the work line's own, never a stamped hint: a mis-stamped row cannot move a text", async () => {
    const db = seededDb(conversation({ workspace_id: W2 }));
    const { conversations } = await loadVendorSmsConversations(db, V);
    expect(conversations.map((c) => c.workspaceId)).toEqual([W1]);
  });

  it("a recycled number: history on a work line is scoped to that line, and a line that cannot be placed is dropped", async () => {
    const db = seededDb(conversation({ work_line_id: "cccccccc-0000-4000-8000-0000000000c9" }));
    expect((await loadVendorSmsConversations(db, V)).conversations).toEqual([]);
  });
});

describe("applyVendorConversationExtras - the list the route returns", () => {
  const storedRow = (over: Partial<PersistedInboxThread> = {}): PersistedInboxThread => ({
    id: "thread-1",
    folder: "inbox",
    from: "Sam Rivera",
    email: "m1@x.co",
    subject: "Leak",
    preview: "In app message",
    body: "Hi Mike, in-app",
    time: "Mon 9:00 AM",
    unread: false,
    conversationKey: `ws:${W1}`,
    workspaceId: W1,
    ...over,
  });

  it("folds the linked texts into the SAME conversation as the in-app row, and names the manager", async () => {
    const db = seededDb(
      merge(
        conversation({}, [{ body: "text one" }]),
        { manager_vendor_records: [{ id: "ven-1", manager_user_id: M1, vendor_user_id: V, row_data: { name: "Mike" } }] },
      ),
    );
    const { rows } = await applyVendorConversationExtras(db, { id: V, name: "Mike", mayReadVendorTexts: true }, [storedRow()]);

    expect(rows).toHaveLength(1);
    expect(rows[0]!.counterparty).toMatchObject({ name: "Sam Rivera", workPhone: "+12065550101" });
    const text = [rows[0]!.body, ...(rows[0]!.messages ?? []).map((m) => m.body)].join("|");
    expect(text).toContain("text one");
    expect(text).toContain("Hi Mike, in-app");
  });

  it("a text-only conversation becomes a derived row the client can never create, marked smsOnly", async () => {
    const db = seededDb(conversation({}, [{ body: "only texts" }]));
    const { rows } = await applyVendorConversationExtras(db, { id: V, name: "Mike", mayReadVendorTexts: true }, []);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: `${VENDOR_SMS_ROW_PREFIX}${W1}`, smsOnly: true, conversationKey: `ws:${W1}` });
    expect(isServerReservedInboxThreadId(rows[0]!.id)).toBe(true);
  });

  it("is not behind the SMS UI flag, and a caller who may not read texts gets none", async () => {
    const db = seededDb(conversation());
    expect((await applyVendorConversationExtras(db, { id: V, mayReadVendorTexts: true }, [])).rows).toHaveLength(1);
    expect((await applyVendorConversationExtras(db, { id: V, mayReadVendorTexts: false }, [])).rows).toHaveLength(0);
  });

  it("a workspace key a vendor row only CLAIMS (no roster link) is never named", async () => {
    const db = seededDb({});
    const { rows } = await applyVendorConversationExtras(db, { id: V, mayReadVendorTexts: false }, [storedRow()]);
    expect(rows[0]!.counterparty).toBeUndefined();
  });
});

describe("linkVerifiedVendorPhoneHistory - verifying links the history already there", () => {
  const rosterRow = (over: Record<string, unknown> = {}, rowData: Record<string, unknown> = {}) => ({
    id: "ven-1",
    manager_user_id: M1,
    vendor_user_id: null,
    row_data: { name: "Mike's Plumbing", phone: "(425) 555-0199", active: true, ...rowData },
    ...over,
  });

  it("links the manager's roster row to the account when the row's OWN phone is the verified phone", async () => {
    const db = seededDb({ manager_vendor_records: [rosterRow()] });
    const result = await linkVerifiedVendorPhoneHistory(db, V);

    expect(result).toMatchObject({ rosterLinked: 1, skipped: null });
    const row = db.tables.manager_vendor_records![0]!;
    expect(row.vendor_user_id).toBe(V);
    expect((row.row_data as Record<string, unknown>).vendorUserId).toBe(V);
  });

  it("never links a roster row with a different phone, whatever the vendor typed as their own work phone", async () => {
    const db = seededDb({
      manager_vendor_records: [rosterRow({}, { phone: "(206) 555-0000" })],
      vendor_business_profiles: [{ user_id: V, work_phone: "(206) 555-0000" }],
    });
    const result = await linkVerifiedVendorPhoneHistory(db, V);

    expect(result.rosterLinked).toBe(0);
    expect(db.tables.manager_vendor_records![0]!.vendor_user_id).toBeNull();
  });

  it("does not take over a row already linked to another account", async () => {
    const db = seededDb({ manager_vendor_records: [rosterRow({ vendor_user_id: OTHER })] });
    expect((await linkVerifiedVendorPhoneHistory(db, V)).rosterLinked).toBe(0);
    expect(db.tables.manager_vendor_records![0]!.vendor_user_id).toBe(OTHER);
  });

  it("re-keys the vendor's past text conversations through the one resolver, in the workspace of each work line", async () => {
    const db = seededDb(merge(conversation(), { manager_vendor_records: [rosterRow()] }));
    const result = await linkVerifiedVendorPhoneHistory(db, V);

    expect(result.stamped).toBe(1);
    const stamped = db.tables.sms_projection_conversations![0]!;
    expect(stamped.workspace_id).toBe(W1);
    expect(String(stamped.conversation_key)).toContain(V);
  });

  it("never links an unverified phone", async () => {
    const db = seededDb(merge(conversation(), { manager_vendor_records: [rosterRow()] }));
    db.tables.profiles!.find((p) => p.id === V)!.phone_verified_at = null;

    expect(await linkVerifiedVendorPhoneHistory(db, V)).toEqual({ rosterLinked: 0, stamped: 0, skipped: "unverified" });
    expect(db.tables.manager_vendor_records![0]!.vendor_user_id).toBeNull();
    expect(db.rpcCalls.filter((c) => c.fn === "stamp_sms_projection_conversation")).toEqual([]);
  });

  it("a number two accounts verified links nothing for either", async () => {
    const db = seededDb(merge(conversation(), { manager_vendor_records: [rosterRow()] }));
    db.tables.profiles!.push({ id: OTHER, email: "dup@x.co", phone: PHONE, phone_verified_at: "2026-10-06T11:00:00Z" });

    expect(await linkVerifiedVendorPhoneHistory(db, V)).toEqual({ rosterLinked: 0, stamped: 0, skipped: "ambiguous" });
    expect(await linkVerifiedVendorPhoneHistory(db, OTHER)).toEqual({ rosterLinked: 0, stamped: 0, skipped: "ambiguous" });
    expect(db.tables.manager_vendor_records![0]!.vendor_user_id).toBeNull();
    expect(db.rpcCalls.filter((c) => c.fn === "stamp_sms_projection_conversation")).toEqual([]);
  });

  it("never re-keys a resident, prospect or manager conversation, or another account's", async () => {
    const mine = conversation();
    const prospect = conversation({ counterparty_role: "prospect" });
    const elsewhere = conversation({ counterparty_user_id: OTHER });
    const db = seededDb(merge(mine, prospect, elsewhere));
    await linkVerifiedVendorPhoneHistory(db, V);

    const stamped = db.rpcCalls.filter((c) => c.fn === "stamp_sms_projection_conversation").map((c) => c.args.p_conversation_id);
    expect(stamped).toEqual([mine.sms_projection_conversations![0]!.id]);
  });
});
