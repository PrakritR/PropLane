import { describe, expect, it } from "vitest";
import { mergeInboxScopedContacts } from "@/lib/manager-inbox-contacts";
import type { InboxScopedContact } from "@/data/inbox-scoped-directory";

function contact(over: Partial<InboxScopedContact>): InboxScopedContact {
  return {
    id: "c-1",
    name: "Jamie",
    email: "jamie@example.com",
    role: "resident",
    ...over,
  };
}

describe("mergeInboxScopedContacts", () => {
  it("dedupes by email and keeps the first entry", () => {
    const merged = mergeInboxScopedContacts(
      [contact({ id: "a", name: "Jamie A" })],
      [contact({ id: "b", name: "Jamie B", email: "jamie@example.com" })],
      [contact({ id: "c", name: "Alex", email: "alex@example.com" })],
    );
    expect(merged).toHaveLength(2);
    expect(merged[0]?.name).toBe("Jamie A");
    expect(merged[1]?.email).toBe("alex@example.com");
  });

  it("drops malformed persisted contacts instead of calling trim on non-strings", () => {
    const malformed = contact({ id: "bad" });
    Object.assign(malformed, { email: { legacy: "not-a-string" } });

    expect(() => mergeInboxScopedContacts([malformed])).not.toThrow();
    expect(mergeInboxScopedContacts([malformed])).toEqual([]);
  });
});
