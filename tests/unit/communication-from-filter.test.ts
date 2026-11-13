import { describe, expect, it } from "vitest";
import {
  COMMUNICATION_FROM_OPTIONS,
  COMMUNICATION_FROM_STORAGE_KEY,
  fromGroupForCounterpartyRole,
  fromGroupForThread,
  readStoredFromFilter,
  writeStoredFromFilter,
} from "@/lib/communication-from-filter";
import { EMPTY_COMMUNICATION_THREAD_FILTERS, threadPassesCommunicationFilters } from "@/lib/communication-thread-filters";
import type { InboxScopedContact } from "@/data/inbox-scoped-directory";

const contacts: InboxScopedContact[] = [
  { id: "c1", name: "Rae Resident", email: "rae@example.com", role: "resident" },
  { id: "c2", name: "Vic Vendor", email: "vic@example.com", role: "vendor" },
  { id: "c3", name: "Mo Manager", email: "mo@example.com", role: "manager" },
];

const threads = [
  { id: "t-rae", email: "rae@example.com" },
  { id: "t-vic", email: "vic@example.com" },
  { id: "t-mo", email: "mo@example.com" },
  { id: "t-lead", email: "lead@example.com", prospectContext: { label: "5259 Brooklyn Ave" } },
  { id: "team-thread:o:ws:w", email: "" },
  { id: "house-thread:o:ws:w:prop:p", email: "" },
  { id: "t-unknown", email: "nobody@example.com" },
  // A resident-looking NAME never decides: only the directory / stamps do.
  { id: "t-named", email: "stranger@example.com", from: "Rae Resident" },
];

function pass(from: "all" | "resident" | "vendor" | "manager" | "prospect", t: (typeof threads)[number]) {
  return threadPassesCommunicationFilters({
    filters: { ...EMPTY_COMMUNICATION_THREAD_FILTERS, from },
    contacts,
    counterpartyEmail: t.email,
    fromGroup: fromGroupForThread(t, contacts),
  });
}

describe("From filter", () => {
  it("offers All, Residents, Vendors, Managers, Prospects", () => {
    expect(COMMUNICATION_FROM_OPTIONS.map((o) => o.label)).toEqual(["All", "Residents", "Vendors", "Managers", "Prospects"]);
  });

  it("derives the group from server truth, never a name", () => {
    expect(threads.map((t) => fromGroupForThread(t, contacts))).toEqual([
      "resident", "vendor", "manager", "prospect", "manager", null, null, null,
    ]);
  });

  it("SMS counterparty roles map: staff are Managers, applicants and prospects are Prospects, unknown is none", () => {
    expect(fromGroupForCounterpartyRole("resident")).toBe("resident");
    expect(fromGroupForCounterpartyRole("vendor")).toBe("vendor");
    expect(fromGroupForCounterpartyRole("manager")).toBe("manager");
    expect(fromGroupForCounterpartyRole("admin")).toBe("manager");
    expect(fromGroupForCounterpartyRole("applicant")).toBe("prospect");
    expect(fromGroupForCounterpartyRole("prospect")).toBe("prospect");
    expect(fromGroupForCounterpartyRole("unknown")).toBeNull();
  });

  it("All passes every conversation; a group passes only its own", () => {
    expect(threads.every((t) => pass("all", t))).toBe(true);
    for (const group of ["resident", "vendor", "manager", "prospect"] as const) {
      const kept = threads.filter((t) => pass(group, t)).map((t) => t.id);
      const expected = threads.filter((t) => fromGroupForThread(t, contacts) === group).map((t) => t.id);
      expect(kept).toEqual(expected);
      expect(kept.length).toBeGreaterThan(0);
    }
  });

  it("an SMS row filters on its stored counterparty role", () => {
    const sms = (role: Parameters<typeof fromGroupForCounterpartyRole>[0]) =>
      threadPassesCommunicationFilters({
        filters: { ...EMPTY_COMMUNICATION_THREAD_FILTERS, from: "vendor" },
        contacts: [],
        counterpartyRole: role ?? undefined,
        fromGroup: fromGroupForCounterpartyRole(role),
      });
    expect(sms("vendor")).toBe(true);
    expect(sms("resident")).toBe(false);
    expect(sms("unknown")).toBe(false);
  });

  it("composes with the other dimensions (Active | Archived is applied before it, search after)", () => {
    const filtered = threads.filter((t) => pass("resident", t));
    expect(filtered.map((t) => t.id)).toEqual(["t-rae"]);
    // search narrows what the From filter already kept; it never widens it
    expect(filtered.filter((t) => t.email.includes("vic"))).toEqual([]);
  });

  it("persists per viewer in localStorage and survives a blocked store", () => {
    const store = new Map<string, string>();
    const storage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(readStoredFromFilter(storage)).toBe("all");
    writeStoredFromFilter("vendor", storage);
    expect(store.get(COMMUNICATION_FROM_STORAGE_KEY)).toBe("vendor");
    expect(readStoredFromFilter(storage)).toBe("vendor");
    store.set(COMMUNICATION_FROM_STORAGE_KEY, "bogus");
    expect(readStoredFromFilter(storage)).toBe("all");
    const blocked = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    };
    expect(readStoredFromFilter(blocked)).toBe("all");
    expect(() => writeStoredFromFilter("vendor", blocked)).not.toThrow();
  });
});
