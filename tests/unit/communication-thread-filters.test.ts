import { describe, expect, it } from "vitest";
import type { InboxScopedContact } from "@/data/inbox-scoped-directory";
import {
  EMPTY_COMMUNICATION_THREAD_FILTERS,
  propertyOptionsFromFilterContacts,
  threadPassesCommunicationFilters,
} from "@/lib/communication-thread-filters";

function contact(overrides: Partial<InboxScopedContact> = {}): InboxScopedContact {
  return {
    id: "res-1",
    name: "Ada",
    email: "ada@example.com",
    role: "resident",
    ...overrides,
  };
}

describe("communication thread filters survive non-string contact fields", () => {
  it("does not throw when contact.email is not a string (the historic b.trim / x.trim crash)", () => {
    const malformed = contact({ email: 18559168031 as unknown as string });
    expect(() =>
      threadPassesCommunicationFilters({
        filters: { ...EMPTY_COMMUNICATION_THREAD_FILTERS, contactIds: ["res-1"] },
        contacts: [malformed],
        counterpartyEmail: "ada@example.com",
      }),
    ).not.toThrow();
    expect(
      threadPassesCommunicationFilters({
        filters: { ...EMPTY_COMMUNICATION_THREAD_FILTERS, contactIds: ["res-1"] },
        contacts: [malformed],
        counterpartyEmail: "ada@example.com",
      }),
    ).toBe(false);
  });

  it("does not throw when propertyId / propertyLabel are numbers", () => {
    const malformed = contact({
      propertyId: 5257 as unknown as string,
      propertyLabel: { street: "Brooklyn" } as unknown as string,
    });
    expect(() => propertyOptionsFromFilterContacts([malformed])).not.toThrow();
    expect(propertyOptionsFromFilterContacts([malformed])).toEqual([]);
    expect(() =>
      threadPassesCommunicationFilters({
        filters: { ...EMPTY_COMMUNICATION_THREAD_FILTERS, propertyIds: ["5257"] },
        contacts: [malformed],
        counterpartyEmail: "ada@example.com",
        propertyId: "5257",
      }),
    ).not.toThrow();
  });

  it("still matches a well-formed contact email", () => {
    expect(
      threadPassesCommunicationFilters({
        filters: { ...EMPTY_COMMUNICATION_THREAD_FILTERS, contactIds: ["res-1"] },
        contacts: [contact()],
        counterpartyEmail: "ada@example.com",
      }),
    ).toBe(true);
  });
});
