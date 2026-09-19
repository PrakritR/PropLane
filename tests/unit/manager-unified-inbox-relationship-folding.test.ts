import { describe, expect, it } from "vitest";
import type { ManagerSmsResidentConversation } from "@/lib/manager-sms-messages";
import {
  collapsePersonInboxThreads,
  inboxThreadMessages,
  type PersistedInboxThread,
} from "@/lib/portal-inbox-storage";
import {
  managerUnifiedEmailPersonKey,
  managerUnifiedEmailBindingEvidence,
  managerUnifiedSmsPersonKey,
} from "@/components/portal/pro-unified-inbox";

const binding = "manager-a:resident:person-1";

function emailThread(propertyId: string): PersistedInboxThread {
  return {
    id: `email-${propertyId}`,
    folder: "inbox",
    from: "Resident",
    email: "resident@example.com",
    subject: "Update",
    preview: "Update",
    body: "Update",
    time: "Sep 18, 10:00 AM",
    unread: true,
    managerUserId: "manager-a",
    propertyId,
    counterpartyRole: "resident",
    smsConversationKey: binding,
  };
}

function smsThread(propertyId: string): ManagerSmsResidentConversation {
  return {
    residentUserId: "resident-1",
    residentEmail: "resident@example.com",
    name: "Resident",
    phone: "+12065550100",
    propertyLabel: propertyId,
    ownerManagerUserId: "manager-a",
    counterpartyRole: "resident",
    conversationKey: binding,
    houses: [{ propertyId, label: propertyId, source: "manual" }],
    messages: [],
  };
}

describe("manager unified inbox relationship folding", () => {
  it.each([
    ["array-only ambiguity", undefined, ["K1", "K2"]],
    ["scalar plus array ambiguity", "K1", ["K2"]],
  ] as const)("does not donate native evidence from %s", (_label, scalar, keys) => {
    const thread = { ...emailThread("property-a"), smsConversationKey: scalar, smsBindingKeys: [...keys] };
    expect(managerUnifiedEmailBindingEvidence([thread]).size).toBe(0);
    expect(managerUnifiedEmailPersonKey(thread)).toBe(`email-isolated:${thread.id}`);
  });

  it("accepts one normalized deduplicated binding and keeps independent K1/K2 display folding", () => {
    const first = { ...emailThread("property-a"), email: " Resident@Example.COM ", smsConversationKey: " K1 ", smsBindingKeys: ["K1", " K1 ", ""] };
    const second = { ...emailThread("property-a"), id: "second", smsConversationKey: "K2" };
    const evidence = managerUnifiedEmailBindingEvidence([first, second]);
    expect([...evidence]).toEqual([
      "K1\0resident@example.com\0manager-a\0property-a\0resident",
      "K2\0resident@example.com\0manager-a\0property-a\0resident",
    ]);
    const person = managerUnifiedEmailPersonKey(first);
    expect(person).toBe(managerUnifiedEmailPersonKey(second));
    for (const key of ["K1", "K2"]) {
      expect(managerUnifiedSmsPersonKey({ ...smsThread("property-a"), conversationKey: key }, evidence)).toBe(person);
    }
    expect(managerUnifiedSmsPersonKey({ ...smsThread("property-a"), conversationKey: "K3" }, evidence)).toBe("sms-isolated:K3");
  });

  it("allows unbound email display identity without donating native evidence", () => {
    const thread = { ...emailThread("property-a"), smsConversationKey: undefined };
    expect(managerUnifiedEmailPersonKey(thread)).toMatch(/^person-relationship:/);
    expect(managerUnifiedEmailBindingEvidence([thread]).size).toBe(0);
  });

  it.each([
    ["missing owner", { managerUserId: undefined }],
    ["missing property", { propertyId: undefined }],
    ["missing role", { counterpartyRole: undefined }],
    ["invalid email", { email: "unknown" }],
    ["conflicting relationship", { identityProvenance: [{ managerUserId: "manager-b", propertyId: "property-a", counterpartyRole: "resident" as const }] }],
    ["partial claims", { managerUserId: undefined, propertyId: undefined, counterpartyRole: undefined, identityProvenance: [{ managerUserId: "manager-a" }, { propertyId: "property-a", counterpartyRole: "resident" as const }] }],
  ] satisfies Array<[string, Partial<PersistedInboxThread>]>)("does not donate native evidence with %s", (_label, changes) => {
    const thread = { ...emailThread("property-a"), ...changes };
    expect(managerUnifiedEmailBindingEvidence([thread]).size).toBe(0);
    expect(managerUnifiedEmailPersonKey(thread)).toBe(`email-isolated:${thread.id}`);
  });

  it("does not let a shared SMS binding fold email histories from different properties", () => {
    const emailA = managerUnifiedEmailPersonKey(emailThread("property-a"));
    const emailB = managerUnifiedEmailPersonKey(emailThread("property-b"));
    const relationships = new Set([
      `${binding}\0resident@example.com\0manager-a\0property-a\0resident`,
      `${binding}\0resident@example.com\0manager-a\0property-b\0resident`,
    ]);

    expect(managerUnifiedSmsPersonKey(smsThread("property-a"), relationships)).toBe(emailA);
    expect(emailB).not.toBe(emailA);
  });

  it("keeps an SMS thread with multiple property tags isolated", () => {
    const ambiguous = smsThread("property-a");
    ambiguous.houses = [
      { propertyId: "property-a", label: "Property A", source: "manual" },
      { propertyId: "property-b", label: "Property B", source: "manual" },
    ];

    expect(managerUnifiedSmsPersonKey(
      ambiguous,
      new Set([`${binding}\0resident@example.com\0manager-a\0property-a\0resident`]),
    )).toBe(`sms-isolated:${binding}`);
  });

  it("requires one normalized email, exact binding, and complete relationship for native display membership", () => {
    const email = emailThread("property-a");
    email.email = " Resident@Example.COM ";
    const native = smsThread("property-a");
    native.residentEmail = "RESIDENT@example.com";
    const evidence = new Set([`${binding}\0resident@example.com\0manager-a\0property-a\0resident`]);

    expect(managerUnifiedSmsPersonKey(native, evidence)).toBe(managerUnifiedEmailPersonKey(email));

    native.residentEmail = "other@example.com";
    expect(managerUnifiedSmsPersonKey(native, evidence)).toBe(`sms-isolated:${binding}`);
  });

  it.each([
    ["owner", (thread: PersistedInboxThread) => { thread.managerUserId = undefined; }, (native: ManagerSmsResidentConversation) => { native.ownerManagerUserId = null; }],
    ["role", (thread: PersistedInboxThread) => { thread.counterpartyRole = undefined; }, (native: ManagerSmsResidentConversation) => { native.counterpartyRole = undefined; }],
  ] as const)("keeps %s-incomplete relationship evidence isolated", (_field, changeEmail, changeNative) => {
    const email = emailThread("property-a");
    const native = smsThread("property-a");
    changeEmail(email);
    changeNative(native);
    const evidence = new Set([`${binding}\0resident@example.com\0manager-a\0property-a\0resident`]);

    expect(managerUnifiedEmailPersonKey(email)).toBe(`email-isolated:${email.id}`);
    expect(managerUnifiedSmsPersonKey(native, evidence)).toBe(`sms-isolated:${binding}`);
  });

  it.each([
    ["owner", (thread: PersistedInboxThread) => { thread.managerUserId = undefined; }],
    ["role", (thread: PersistedInboxThread) => { thread.counterpartyRole = undefined; }],
  ] as const)("does not fold when only the email %s proof is incomplete", (_field, changeEmail) => {
    const email = emailThread("property-a");
    const native = smsThread("property-a");
    changeEmail(email);
    const evidence = new Set([`${binding}\0resident@example.com\0manager-a\0property-a\0resident`]);

    expect(managerUnifiedEmailPersonKey(email)).toBe(`email-isolated:${email.id}`);
    expect(managerUnifiedSmsPersonKey(native, evidence)).toBe(`person-relationship:resident@example.com:manager-a\0property-a\0resident`);
  });

  it.each([
    ["owner", (native: ManagerSmsResidentConversation) => { native.ownerManagerUserId = null; }],
    ["role", (native: ManagerSmsResidentConversation) => { native.counterpartyRole = undefined; }],
  ] as const)("does not fold when only the native %s proof is incomplete", (_field, changeNative) => {
    const email = emailThread("property-a");
    const native = smsThread("property-a");
    changeNative(native);
    const evidence = new Set([`${binding}\0resident@example.com\0manager-a\0property-a\0resident`]);

    expect(managerUnifiedEmailPersonKey(email)).toBe(`person-relationship:resident@example.com:manager-a\0property-a\0resident`);
    expect(managerUnifiedSmsPersonKey(native, evidence)).toBe(`sms-isolated:${binding}`);
  });

  it.each([
    ["owner", (native: ManagerSmsResidentConversation) => { native.ownerManagerUserId = "manager-b"; }],
    ["property", (native: ManagerSmsResidentConversation) => { native.houses = [{ propertyId: "property-b", label: "Property B", source: "manual" }]; }],
    ["role", (native: ManagerSmsResidentConversation) => { native.counterpartyRole = "applicant"; }],
  ] as const)("keeps a native row with a different %s isolated", (_field, changeNative) => {
    const native = smsThread("property-a");
    changeNative(native);
    expect(managerUnifiedSmsPersonKey(
      native,
      new Set([`${binding}\0resident@example.com\0manager-a\0property-a\0resident`]),
    )).toBe(`sms-isolated:${binding}`);
  });

  it("keeps an unbound native key isolated", () => {
    const native = smsThread("property-a");
    native.conversationKey = "K3";
    expect(managerUnifiedSmsPersonKey(
      native,
      new Set([`${binding}\0resident@example.com\0manager-a\0property-a\0resident`]),
    )).toBe("sms-isolated:K3");
  });

  it.each([
    ["unknown-first", ["unknown", "property-a", "property-b"]],
    ["known-a-first", ["property-a", "unknown", "property-b"]],
    ["known-b-first", ["property-b", "unknown", "property-a"]],
  ] as const)("keeps unknown historical content independent for the %s input order", (_label, order) => {
    const rows = order.map((id, index): PersistedInboxThread => {
      if (id === "unknown") {
        return {
          ...emailThread("unknown"),
          id: "unknown-history",
          propertyId: undefined,
          smsConversationKey: undefined,
          smsBindingKeys: undefined,
          body: "U historical content",
          preview: "U historical content",
          time: `Sep 18, 10:0${index} AM`,
        };
      }
      return {
        ...emailThread(id),
        id: `${id}-history`,
        body: `${id.toUpperCase()} historical content`,
        preview: `${id.toUpperCase()} historical content`,
        time: `Sep 18, 10:0${index} AM`,
      };
    });

    const collapsed = collapsePersonInboxThreads(rows, { mergeFolders: true });

    expect(collapsed).toHaveLength(3);
    expect(collapsed.find((row) => row.id === "unknown-history")).toBeTruthy();
    expect(collapsed.find((row) => row.id === "unknown-history")).toMatchObject({
      propertyId: undefined,
      smsConversationKey: undefined,
      body: "U historical content",
    });
    expect(inboxThreadMessages(collapsed.find((row) => row.id === "unknown-history")!)
      .map((message) => message.body))
      .toEqual(["U historical content"]);
  });

  it("allows a legacy row to merge only after durable relationship evidence proves it", () => {
    const provenLegacy: PersistedInboxThread = {
      ...emailThread("property-a"),
      id: "legacy-proven",
      propertyId: undefined,
      smsConversationKey: undefined,
      identityProvenance: [{
        managerUserId: "manager-a",
        propertyId: "property-a",
        counterpartyRole: "resident",
      }],
      body: "Legacy A history",
      preview: "Legacy A history",
    };
    const current = {
      ...emailThread("property-a"),
      id: "current-a",
      body: "Current A history",
      preview: "Current A history",
      time: "Sep 18, 11:00 AM",
    };

    const collapsed = collapsePersonInboxThreads([provenLegacy, current], { mergeFolders: true });
    expect(collapsed).toHaveLength(1);
    expect(inboxThreadMessages(collapsed[0]!).map((message) => message.body)).toEqual([
      "Legacy A history",
      "Current A history",
    ]);
  });
});
