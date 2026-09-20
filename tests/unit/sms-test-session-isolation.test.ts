import { describe, expect, it } from "vitest";

import { findOrCreateSmsAgentTestSession } from "@/lib/agent/sms-agent-turn.server";
import { createMemoryDb } from "./support/memory-supabase";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const MANAGER = "22222222-2222-4222-8222-222222222222";

function seededSession() {
  return createMemoryDb({
    agent_sessions: [{
      id: "session-a",
      landlord_id: MANAGER,
      user_id: ACTOR,
      kind: `resident_sms_test:${MANAGER}:listing-a`,
      vendor_phone_e164: null,
      status: "active",
      test_actor_user_id: ACTOR,
      sms_test_manager_user_id: MANAGER,
      sms_test_mode: "resident",
      sms_test_target_listing_id: "listing-a",
      portal: "resident",
    }],
  });
}

describe("manager/resident SMS test session isolation", () => {
  it("resumes only an exact active actor, manager, mode, and listing context", async () => {
    const db = seededSession();
    await expect(findOrCreateSmsAgentTestSession(db as never, {
      kind: `resident_sms_test:${MANAGER}:listing-a`,
      managerUserId: MANAGER,
      actorUserId: ACTOR,
      mode: "resident",
      portal: "resident",
      targetListingId: "listing-a",
      sessionId: "session-a",
    })).resolves.toMatchObject({ id: "session-a" });

    for (const args of [
      { kind: `resident_sms_test:${MANAGER}:listing-b`, managerUserId: MANAGER, actorUserId: ACTOR, mode: "resident" as const, targetListingId: "listing-b" },
      { kind: `resident_sms_test:${MANAGER}:listing-a`, managerUserId: MANAGER, actorUserId: "other", mode: "resident" as const, targetListingId: "listing-a" },
      { kind: "resident_sms_test:other:listing-a", managerUserId: "other", actorUserId: ACTOR, mode: "resident" as const, targetListingId: "listing-a" },
      { kind: `manager_sms_test:${MANAGER}`, managerUserId: MANAGER, actorUserId: ACTOR, mode: "manager" as const, targetListingId: null },
    ]) {
      await expect(findOrCreateSmsAgentTestSession(db as never, {
        ...args,
        portal: "resident",
        sessionId: "session-a",
      })).resolves.toBeNull();
    }
  });

  it("does not reactivate a closed session supplied by the client", async () => {
    const db = seededSession();
    db.__tables.agent_sessions[0].status = "closed";
    await expect(findOrCreateSmsAgentTestSession(db as never, {
      kind: `resident_sms_test:${MANAGER}:listing-a`,
      managerUserId: MANAGER,
      actorUserId: ACTOR,
      mode: "resident",
      portal: "resident",
      targetListingId: "listing-a",
      sessionId: "session-a",
    })).resolves.toBeNull();
    expect(db.__tables.agent_sessions[0].status).toBe("closed");
  });

  it("creates a fresh phone-less session when no server session id is supplied", async () => {
    const db = createMemoryDb({ agent_sessions: [] });
    await findOrCreateSmsAgentTestSession(db as never, {
      kind: `manager_sms_test:${MANAGER}`,
      managerUserId: MANAGER,
      actorUserId: ACTOR,
      mode: "manager",
      portal: "manager",
    });
    expect(db.__tables.agent_sessions).toEqual([
      expect.objectContaining({
        kind: `manager_sms_test:${MANAGER}`,
        landlord_id: MANAGER,
        user_id: ACTOR,
        vendor_phone_e164: null,
        test_actor_user_id: ACTOR,
        sms_test_manager_user_id: MANAGER,
        sms_test_mode: "manager",
      }),
    ]);
  });
});
