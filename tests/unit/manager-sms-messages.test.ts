import { describe, expect, it } from "vitest";
import type {
  ManagerSmsConversationsPayload,
  ManagerSmsMessageRow,
  ManagerSmsResidentConversation,
} from "@/lib/manager-sms-messages";
import {
  normalizeManagerSmsConversationsPayload,
  smsThreadBucketForLatestMessage,
  sortSmsConversationRows,
  isPhoneLikeLabel,
  smsConversationDisplayName,
  smsConversationSubtitle,
  unloggedSmsWarning,
  MANAGER_SMS_TAB_DEFS,
  NON_HUMAN_AUTHORED_SMS_SOURCES,
} from "@/lib/manager-sms-messages";

describe("unloggedSmsWarning", () => {
  it("warns about the takeover flip only for a HUMAN-composed send", () => {
    // A dropped `work_number` row costs the takeover signal itself — the router
    // keeps auto-replying over a conversation the manager has joined — so its
    // copy has to say more than the share's missing audit entry.
    for (const source of ["work_number", "relay"] as const) {
      expect(NON_HUMAN_AUTHORED_SMS_SOURCES).not.toContain(source);
      expect(unloggedSmsWarning(source)).toContain("auto-replying");
    }
    for (const source of NON_HUMAN_AUTHORED_SMS_SOURCES) {
      expect(unloggedSmsWarning(source)).not.toContain("auto-replying");
    }
  });

  it("always says the text DID go out, so nobody re-sends it", () => {
    expect(unloggedSmsWarning("work_number")).toMatch(/^Text sent,/);
    expect(unloggedSmsWarning("lead_invite")).toMatch(/^Text sent,/);
  });
});

describe("manager-sms-messages types", () => {
  it("accepts a conversations payload shape used by ManagerSmsPanel", () => {
    const message: ManagerSmsMessageRow = {
      id: "msg-1",
      direction: "inbound",
      body: "Hello manager",
      fromPhone: "+12065550100",
      toPhone: "+12065550999",
      messageSid: "SM123",
      source: "work_number",
      createdAt: "2026-07-16T12:00:00.000Z",
      storageTable: "inbound_sms_log",
    };
    const resident: ManagerSmsResidentConversation = {
      residentUserId: "user-1",
      residentEmail: "resident@test.proplane.local",
      name: "Test Resident",
      phone: "+12065550100",
      propertyLabel: "Unit A",
      messages: [message],
    };
    const payload: ManagerSmsConversationsPayload = {
      workNumber: "+12065550999",
      personalPhone: null,
      phoneVerified: false,
      forwardInbound: false,
      smsConfigured: true,
      residents: [resident],
    };

    expect(payload.residents[0]?.messages[0]?.direction).toBe("inbound");
    expect(payload.workNumber).toBe("+12065550999");
  });

  it("normalizes missing residents and message arrays", () => {
    const payload = normalizeManagerSmsConversationsPayload({
      workNumber: "+12065550000",
      residents: [
        {
          residentUserId: null,
          residentEmail: "resident@test.proplane.local",
          name: "",
          phone: null,
          propertyLabel: null,
          messages: undefined as unknown as ManagerSmsMessageRow[],
        },
      ],
    });
    expect(payload.residents).toHaveLength(1);
    expect(payload.residents[0]?.name).toBe("resident@test.proplane.local");
    expect(payload.residents[0]?.messages).toEqual([]);
  });

  it("categorizes latest message into sms buckets", () => {
    const inbound: ManagerSmsMessageRow = {
      id: "msg-inbound",
      direction: "inbound",
      body: "Hi",
      fromPhone: "+12065550001",
      toPhone: "+12065550002",
      messageSid: null,
      source: "work_number",
      createdAt: "2026-07-16T12:00:00.000Z",
      storageTable: "inbound_sms_log",
    };
    const outbound: ManagerSmsMessageRow = {
      ...inbound,
      id: "msg-outbound",
      direction: "outbound",
    };
    expect(smsThreadBucketForLatestMessage(inbound, new Set())).toBe("unopened");
    expect(smsThreadBucketForLatestMessage(inbound, new Set(["msg-inbound"]))).toBe("opened");
    expect(smsThreadBucketForLatestMessage(outbound, new Set())).toBe("sent");
  });

  it("exposes all/unread tab defs for legacy routes", () => {
    expect(MANAGER_SMS_TAB_DEFS.map((t) => t.id)).toEqual(["all", "unopened"]);
  });

  it("sorts SMS threads by newest, name, and house", () => {
    const rows = [
      {
        resident: { name: "Zoe", propertyLabel: "B House", residentEmail: null, phone: "+1" },
        lastMessage: { createdAt: "2026-07-16T10:00:00.000Z" } as ManagerSmsMessageRow,
      },
      {
        resident: { name: "Amy", propertyLabel: "A House", residentEmail: null, phone: "+2" },
        lastMessage: { createdAt: "2026-07-15T10:00:00.000Z" } as ManagerSmsMessageRow,
      },
      {
        resident: { name: "Bob", propertyLabel: "A House", residentEmail: null, phone: "+3" },
        lastMessage: null,
      },
    ];
    expect(sortSmsConversationRows(rows, "newest").map((r) => r.resident.name)).toEqual(["Zoe", "Amy", "Bob"]);
    expect(sortSmsConversationRows(rows, "name").map((r) => r.resident.name)).toEqual(["Amy", "Bob", "Zoe"]);
    expect(sortSmsConversationRows(rows, "house").map((r) => r.resident.name)).toEqual(["Amy", "Bob", "Zoe"]);
  });

  it("sorts by the label the row renders, not the raw phone-like name", () => {
    const at = (iso: string) => ({ createdAt: iso }) as ManagerSmsMessageRow;
    const rows = [
      {
        // Renders "Texter ····1976" — must not sort under "+".
        resident: { name: "+15105791976", propertyLabel: null, residentEmail: null, phone: "+15105791976" },
        lastMessage: at("2026-07-16T10:00:00.000Z"),
      },
      {
        // Renders "Ballard Commons · 2B" — must not sort by its phone digits.
        resident: { name: "+12065550142", propertyLabel: "Ballard Commons · 2B", residentEmail: null, phone: "+12065550142" },
        lastMessage: at("2026-07-15T10:00:00.000Z"),
      },
      {
        resident: { name: "Amy", propertyLabel: null, residentEmail: null, phone: "+3" },
        lastMessage: at("2026-07-14T10:00:00.000Z"),
      },
    ];
    expect(sortSmsConversationRows(rows, "name").map((r) => smsConversationDisplayName(r.resident))).toEqual([
      "Amy",
      "Ballard Commons · 2B",
      "Texter ····1976",
    ]);
    // Newest/oldest ordering is untouched by the label change.
    expect(sortSmsConversationRows(rows, "newest").map((r) => r.resident.name)).toEqual([
      "+15105791976",
      "+12065550142",
      "Amy",
    ]);
  });
});

describe("smsConversationDisplayName — never surface a raw phone in Communication", () => {
  it("detects phone-like labels", () => {
    expect(isPhoneLikeLabel("+15105791976")).toBe(true);
    expect(isPhoneLikeLabel("(206) 555-0142")).toBe(true);
    expect(isPhoneLikeLabel("206-555-0142")).toBe(true);
    expect(isPhoneLikeLabel("Jane Resident")).toBe(false);
    expect(isPhoneLikeLabel("")).toBe(false);
    expect(isPhoneLikeLabel(null)).toBe(false);
    // Too few digits to be a phone number.
    expect(isPhoneLikeLabel("12345")).toBe(false);
  });

  it("keeps a real name", () => {
    expect(
      smsConversationDisplayName({ name: "Jane Resident", propertyLabel: "Unit A", residentEmail: "jane@x.com" }),
    ).toBe("Jane Resident");
  });

  it("falls back to unit, then email, then a masked last-4 handle when the name is just a phone", () => {
    expect(
      smsConversationDisplayName({ name: "+15105791976", propertyLabel: "Ballard Commons · 2B", residentEmail: "a@x.com" }),
    ).toBe("Ballard Commons · 2B");
    expect(
      smsConversationDisplayName({ name: "+15105791976", propertyLabel: null, residentEmail: "a@x.com" }),
    ).toBe("a@x.com");
    expect(
      smsConversationDisplayName({ name: "+15105791976", propertyLabel: null, residentEmail: null }),
    ).toBe("Texter ····1976");
    expect(
      smsConversationDisplayName({ name: "", propertyLabel: null, residentEmail: null, phone: "+12065550142" }),
    ).toBe("Texter ····0142");
    expect(
      smsConversationDisplayName({ name: "", propertyLabel: null, residentEmail: null, phone: null }),
    ).toBe("Unknown contact");
  });

  it("keeps prospect threads distinguishable from one another", () => {
    const a = smsConversationDisplayName({ name: "+15105791976", propertyLabel: null, residentEmail: null });
    const b = smsConversationDisplayName({ name: "+12065550142", propertyLabel: null, residentEmail: null });
    expect(a).not.toBe(b);
    expect(a).not.toContain("+1");
    expect(b).not.toContain("+1");
  });

  it("does not repeat the field the display name already used as the subtitle", () => {
    // Named resident: the unit is still new information under the name.
    expect(
      smsConversationSubtitle({ name: "Jane Resident", propertyLabel: "Unit A", residentEmail: "jane@x.com" }),
    ).toBe("Unit A");
    // Phone-like name promoted the unit to the title — fall through to the email.
    expect(
      smsConversationSubtitle({ name: "+15105791976", propertyLabel: "Unit A", residentEmail: "jane@x.com" }),
    ).toBe("jane@x.com");
    // Email became the title; nothing left to show.
    expect(
      smsConversationSubtitle({ name: "+15105791976", propertyLabel: null, residentEmail: "jane@x.com" }),
    ).toBe("");
  });
});
