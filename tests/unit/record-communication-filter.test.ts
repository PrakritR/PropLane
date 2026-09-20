import { describe, expect, it } from "vitest";
import type { InboxScopedContact } from "@/data/inbox-scoped-directory";
import {
  EMPTY_COMMUNICATION_THREAD_FILTERS,
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

describe("record-linked communication filtering (recordRefs / recordKinds)", () => {
  it("matches a thread whose recordRef is in the filter's recordRefs list", () => {
    expect(
      threadPassesCommunicationFilters({
        filters: { ...EMPTY_COMMUNICATION_THREAD_FILTERS, recordRefs: [{ kind: "payment", id: "chg-1" }] },
        contacts: [contact()],
        counterpartyEmail: "ada@example.com",
        recordRef: { kind: "payment", id: "chg-1" },
      }),
    ).toBe(true);
  });

  it("rejects a thread whose recordRef id does not match, even with the same kind", () => {
    expect(
      threadPassesCommunicationFilters({
        filters: { ...EMPTY_COMMUNICATION_THREAD_FILTERS, recordRefs: [{ kind: "payment", id: "chg-1" }] },
        contacts: [contact()],
        counterpartyEmail: "ada@example.com",
        recordRef: { kind: "payment", id: "chg-2" },
      }),
    ).toBe(false);
  });

  it("rejects a thread whose recordRef kind does not match, even with the same id", () => {
    expect(
      threadPassesCommunicationFilters({
        filters: { ...EMPTY_COMMUNICATION_THREAD_FILTERS, recordRefs: [{ kind: "payment", id: "shared-1" }] },
        contacts: [contact()],
        counterpartyEmail: "ada@example.com",
        recordRef: { kind: "lease", id: "shared-1" },
      }),
    ).toBe(false);
  });

  it("a thread with NO recordRef never matches a recordRefs filter", () => {
    expect(
      threadPassesCommunicationFilters({
        filters: { ...EMPTY_COMMUNICATION_THREAD_FILTERS, recordRefs: [{ kind: "payment", id: "chg-1" }] },
        contacts: [contact()],
        counterpartyEmail: "ada@example.com",
        recordRef: undefined,
      }),
    ).toBe(false);
  });

  it("a thread with NO recordRef never matches a recordKinds filter", () => {
    expect(
      threadPassesCommunicationFilters({
        filters: { ...EMPTY_COMMUNICATION_THREAD_FILTERS, recordKinds: ["lease"] },
        contacts: [contact()],
        counterpartyEmail: "ada@example.com",
      }),
    ).toBe(false);
  });

  it("matches on recordKinds alone (the inbox 'About' filter)", () => {
    expect(
      threadPassesCommunicationFilters({
        filters: { ...EMPTY_COMMUNICATION_THREAD_FILTERS, recordKinds: ["lease", "application"] },
        contacts: [contact()],
        counterpartyEmail: "ada@example.com",
        recordRef: { kind: "lease", id: "lease-1" },
      }),
    ).toBe(true);
  });

  it("recordRefs narrows on TOP of the existing property/role/person filters — it never widens what the viewer could already read", () => {
    // The person filter alone would reject this thread (wrong contact id);
    // adding a matching recordRefs filter must not override that rejection.
    expect(
      threadPassesCommunicationFilters({
        filters: {
          ...EMPTY_COMMUNICATION_THREAD_FILTERS,
          contactIds: ["someone-else"],
          recordRefs: [{ kind: "payment", id: "chg-1" }],
        },
        contacts: [contact()],
        counterpartyEmail: "ada@example.com",
        recordRef: { kind: "payment", id: "chg-1" },
      }),
    ).toBe(false);
  });

  it("a recordRefs-only filter (no property/role/person dimensions) needs no contacts to resolve", () => {
    expect(
      threadPassesCommunicationFilters({
        filters: { ...EMPTY_COMMUNICATION_THREAD_FILTERS, recordRefs: [{ kind: "service", id: "wo-9" }] },
        contacts: [],
        counterpartyEmail: "vendor@example.com",
        recordRef: { kind: "service", id: "wo-9" },
      }),
    ).toBe(true);
  });

  it("no recordRefs/recordKinds filter set means the record dimension is a no-op (existing behavior unchanged)", () => {
    expect(
      threadPassesCommunicationFilters({
        filters: EMPTY_COMMUNICATION_THREAD_FILTERS,
        contacts: [contact()],
        counterpartyEmail: "ada@example.com",
        recordRef: { kind: "payment", id: "chg-1" },
      }),
    ).toBe(true);
  });
});
