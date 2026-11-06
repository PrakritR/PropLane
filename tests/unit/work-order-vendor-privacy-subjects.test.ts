import { describe, expect, it } from "vitest";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import {
  SMS_TEST_PROVENANCE_ROW_KEYS,
  withSmsTestProvenance,
  readSmsTestProvenance,
} from "@/lib/sms/sms-test-provenance";
import {
  projectWorkOrderForHiredVendor,
  projectWorkOrderForOfferedVendor,
} from "@/lib/work-order-vendor-privacy";

/**
 * An SMS test session stamps operator provenance onto the work order's own payload: the
 * actor's Auth id, the manager's, the session and the test workspace. A vendor read carries
 * no Auth ids, so none of it may survive either projection — at any depth, under any of the
 * spellings `readSmsTestProvenance` accepts.
 */
const SENTINEL = {
  actorUserId: "sentinel-actor-aaaaaaaa",
  managerUserId: "sentinel-manager-bbbbbbbb",
  sessionId: "sentinel-session-cccccccc",
  workspaceId: "sentinel-workspace-dddddddd",
};

/** Every spelling, so a key missing from the strip list shows up as a surviving value. */
function stampEverySpelling(row: Record<string, unknown>): Record<string, unknown> {
  return {
    ...withSmsTestProvenance(row, SENTINEL),
    sms_test_actor_user_id: SENTINEL.actorUserId,
    sms_test_manager_user_id: SENTINEL.managerUserId,
    sms_test_session_id: SENTINEL.sessionId,
    sms_test_workspace_id: SENTINEL.workspaceId,
    test_actor_user_id: SENTINEL.actorUserId,
    test_session_id: SENTINEL.sessionId,
    testWorkspaceId: SENTINEL.workspaceId,
    test_workspace_id: SENTINEL.workspaceId,
  };
}

const stamped = (): DemoManagerWorkOrderRow =>
  stampEverySpelling({
    id: "WO-1",
    title: "Leaking sink",
    bucket: "open",
    propertyName: "Alder House",
    propertyAddress: "100 Main St, Seattle, WA 98101",
    residentUserId: "resident-auth-id",
    vendorId: "vendor-1",
    vendorUserId: "vendor-auth-id",
    vendorAssignedAt: "2026-10-30T00:00:00.000Z",
  }) as unknown as DemoManagerWorkOrderRow;

function keysAtEveryDepth(value: unknown, found = new Set<string>()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) keysAtEveryDepth(item, found);
    return found;
  }
  if (!value || typeof value !== "object") return found;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    found.add(key);
    keysAtEveryDepth(child, found);
  }
  return found;
}

describe("SMS test provenance never reaches a vendor", () => {
  it("stamps every spelling on the fixture, so the assertions below have something to catch", () => {
    const row = stamped() as unknown as Record<string, unknown>;
    const present = keysAtEveryDepth(row);
    for (const key of SMS_TEST_PROVENANCE_ROW_KEYS) expect(present.has(key)).toBe(true);
    // The real reader agrees this row is an SMS-test row before projection.
    expect(readSmsTestProvenance(row)).toMatchObject(SENTINEL);
  });

  for (const [label, project] of [
    ["offered", projectWorkOrderForOfferedVendor],
    ["hired", projectWorkOrderForHiredVendor],
  ] as const) {
    it(`strips every provenance key and sentinel value from the ${label} projection`, () => {
      const projected = project(stamped()) as unknown as Record<string, unknown>;

      // No key of the family survives, at any depth. Drop one from
      // SMS_TEST_PROVENANCE_ROW_KEYS and this fails on the surviving key.
      const survived = keysAtEveryDepth(projected);
      for (const key of SMS_TEST_PROVENANCE_ROW_KEYS) expect(survived.has(key)).toBe(false);

      // And no sentinel VALUE survives under any renaming.
      const serialized = JSON.stringify(projected);
      for (const value of Object.values(SENTINEL)) expect(serialized).not.toContain(value);
      expect(serialized).not.toContain("resident-auth-id");
      expect(serialized).not.toContain("vendor-auth-id");

      // The reader can no longer see an SMS-test row in what the vendor got.
      expect(readSmsTestProvenance(projected)).toBeNull();

      // The job itself still arrives.
      expect(projected.title).toBe("Leaking sink");
    });
  }
});
