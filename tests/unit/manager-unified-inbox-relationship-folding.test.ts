import { describe, expect, it } from "vitest";
import type { ManagerSmsResidentConversation } from "@/lib/manager-sms-messages";
import {
  collapsePersonInboxThreads,
  inboxThreadMessages,
  type PersistedInboxThread,
} from "@/lib/portal-inbox-storage";
import {
  managerUnifiedEmailPersonKey,
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
  it("does not let a shared SMS binding fold email histories from different properties", () => {
    const emailA = managerUnifiedEmailPersonKey(emailThread("property-a"), [binding]);
    const emailB = managerUnifiedEmailPersonKey(emailThread("property-b"), [binding]);
    const relationships = new Set([
      `${binding}\0manager-a\0property-a\0resident`,
      `${binding}\0manager-a\0property-b\0resident`,
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
      new Set([`${binding}\0manager-a\0property-a\0resident`]),
    )).toBe(`sms-isolated:${binding}`);
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
