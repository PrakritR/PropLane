import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { portalInboxReadObservation } from "@/lib/portal-inbox-read-state.server";

const record = (rowData: unknown) => ({
  id: "thread-1",
  scope: "axis_portal_inbox_manager_v1",
  owner_user_id: "manager-1",
  participant_email: "resident@example.com",
  thread_type: null,
  updated_at: "2026-09-13T18:00:00.000Z",
  row_data: rowData,
});

function expected(recordValue: ReturnType<typeof record>): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonical);
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, child]) => [key, canonical(child)]),
      );
    }
    return value;
  };
  return createHash("sha256")
    .update(JSON.stringify(canonical({
      id: recordValue.id,
      scope: recordValue.scope,
      ownerUserId: recordValue.owner_user_id,
      participantEmail: recordValue.participant_email,
      threadType: recordValue.thread_type,
      updatedAt: recordValue.updated_at,
      rowData: recordValue.row_data,
    })))
    .digest("hex");
}

describe("portal inbox read observations", () => {
  it("hashes the durable identity, revision, and complete raw row", () => {
    const value = record({ unread: true, messages: [{ id: "m1", body: "hello" }] });
    expect(portalInboxReadObservation(value)).toBe(expected(value));
    expect(portalInboxReadObservation(value)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("is stable for object key order but changes for array or revision changes", () => {
    const first = record({ unread: true, metadata: { b: 2, a: 1 }, messages: ["one", "two"] });
    const reordered = record({ messages: ["one", "two"], metadata: { a: 1, b: 2 }, unread: true });
    expect(portalInboxReadObservation(first)).toBe(portalInboxReadObservation(reordered));
    expect(portalInboxReadObservation(record({ unread: true, metadata: { a: 1, b: 2 }, messages: ["two", "one"] }))).not.toBe(portalInboxReadObservation(first));
    expect(portalInboxReadObservation({ ...first, updated_at: "2026-09-13T18:00:00.001Z" })).not.toBe(portalInboxReadObservation(first));
  });

  it("includes ownership and scope so an observation is not portable", () => {
    const value = record({ unread: true });
    expect(portalInboxReadObservation({ ...value, owner_user_id: "manager-2" })).not.toBe(portalInboxReadObservation(value));
    expect(portalInboxReadObservation({ ...value, scope: "axis_portal_inbox_resident_v1" })).not.toBe(portalInboxReadObservation(value));
  });
});
