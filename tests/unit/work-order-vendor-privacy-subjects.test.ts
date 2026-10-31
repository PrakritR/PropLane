import { describe, expect, it } from "vitest";
import type { DemoManagerWorkOrderRow } from "@/data/demo-portal";
import {
  projectWorkOrderForHiredVendor,
  projectWorkOrderForOfferedVendor,
} from "@/lib/work-order-vendor-privacy";

/**
 * An SMS test session stamps operator provenance onto the work order's own payload
 * (`stampSmsTestProvenance`): the actor's Auth id, the manager's, the session and the test
 * workspace. A vendor read carries no Auth ids, so none of it may survive either projection.
 */
const stamped = (): DemoManagerWorkOrderRow =>
  ({
    id: "WO-1",
    title: "Leaking sink",
    bucket: "open",
    propertyName: "Alder House",
    propertyAddress: "100 Main St, Seattle, WA 98101",
    vendorId: "vendor-1",
    vendorAssignedAt: "2026-10-30T00:00:00.000Z",
    smsTestProvenance: {
      actorUserId: "actor-auth-id",
      managerUserId: "manager-auth-id",
      sessionId: "sms-session-1",
      workspaceId: "test-workspace-1",
    },
    sms_test_actor_user_id: "actor-auth-id",
    sms_test_manager_user_id: "manager-auth-id",
    sms_test_session_id: "sms-session-1",
    sms_test_workspace_id: "test-workspace-1",
  }) as unknown as DemoManagerWorkOrderRow;

const LEAKED = [
  "actor-auth-id",
  "manager-auth-id",
  "sms-session-1",
  "test-workspace-1",
];

describe("SMS test provenance never reaches a vendor", () => {
  for (const [label, project] of [
    ["offered", projectWorkOrderForOfferedVendor],
    ["hired", projectWorkOrderForHiredVendor],
  ] as const) {
    it(`strips the provenance object and its flat columns from the ${label} projection`, () => {
      const projected = project(stamped()) as unknown as Record<string, unknown>;
      expect(projected.smsTestProvenance).toBeUndefined();
      expect(projected.sms_test_actor_user_id).toBeUndefined();
      expect(projected.sms_test_manager_user_id).toBeUndefined();
      expect(projected.sms_test_session_id).toBeUndefined();
      expect(projected.sms_test_workspace_id).toBeUndefined();
      // Nested, too: `withoutAuthSubjects` recurses, so no depth may carry a subject.
      const serialized = JSON.stringify(projected);
      for (const value of LEAKED) expect(serialized).not.toContain(value);
      // The job itself still arrives.
      expect(projected.title).toBe("Leaking sink");
    });
  }
});
