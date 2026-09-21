import { describe, expect, it } from "vitest";

import { findOrCreateLeasingSmsTestSession } from "@/lib/agent/leasing-sms-agent.server";
import { createMemoryDb } from "./support/memory-supabase";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const MANAGER = "22222222-2222-4222-8222-222222222222";

describe("leasing SMS test session identity", () => {
  it("persists authenticated actor and manager identity without a fake phone", async () => {
    const db = createMemoryDb({ agent_sessions: [] });

    const session = await findOrCreateLeasingSmsTestSession(db as never, {
      landlordId: MANAGER,
      actorUserId: ACTOR,
      sessionKind: `leasing_sms_test:${MANAGER}:listing-a`,
      targetListingId: "listing-a",
    });

    expect(session).not.toBeNull();
    expect(db.__tables.agent_sessions).toHaveLength(1);
    expect(db.__tables.agent_sessions[0]).toMatchObject({
      landlord_id: MANAGER,
      user_id: ACTOR,
      kind: `leasing_sms_test:${MANAGER}:listing-a`,
      vendor_phone_e164: null,
      test_actor_user_id: ACTOR,
      sms_test_manager_user_id: MANAGER,
      sms_test_mode: "prospect",
      sms_test_target_listing_id: "listing-a",
      portal: "resident",
    });
  });

  it("reuses only the exact actor, manager, and mode-scoped test session", async () => {
    const db = createMemoryDb({
      agent_sessions: [{
        id: "session-a",
        landlord_id: MANAGER,
        user_id: ACTOR,
        kind: `leasing_sms_test:${MANAGER}:listing-a`,
        vendor_phone_e164: null,
        status: "active",
        test_actor_user_id: ACTOR,
        sms_test_manager_user_id: MANAGER,
        sms_test_mode: "prospect",
        sms_test_target_listing_id: "listing-a",
      }],
    });

    await expect(findOrCreateLeasingSmsTestSession(db as never, {
      landlordId: MANAGER,
      actorUserId: ACTOR,
      sessionKind: `leasing_sms_test:${MANAGER}:listing-a`,
      targetListingId: "listing-a",
      sessionId: "session-a",
    })).resolves.toMatchObject({ id: "session-a" });
    expect(db.__tables.agent_sessions).toHaveLength(1);
  });

  it("rejects a stale session after actor, manager, kind, mode, or status changes", async () => {
    const db = createMemoryDb({
      agent_sessions: [{
        id: "session-a",
        landlord_id: MANAGER,
        user_id: ACTOR,
        kind: `leasing_sms_test:${MANAGER}:listing-a`,
        vendor_phone_e164: null,
        status: "active",
        test_actor_user_id: ACTOR,
        sms_test_manager_user_id: MANAGER,
        sms_test_mode: "prospect",
        sms_test_target_listing_id: "listing-a",
      }],
    });

    for (const args of [
      { landlordId: MANAGER, actorUserId: "other-actor", targetListingId: "listing-a", sessionKind: `leasing_sms_test:${MANAGER}:listing-a` },
      { landlordId: "other-manager", actorUserId: ACTOR, targetListingId: "listing-a", sessionKind: "leasing_sms_test:other-manager:listing-a" },
      { landlordId: MANAGER, actorUserId: ACTOR, targetListingId: "listing-b", sessionKind: `leasing_sms_test:${MANAGER}:listing-b` },
    ]) {
      await expect(findOrCreateLeasingSmsTestSession(db as never, {
        ...args,
        sessionId: "session-a",
      })).resolves.toBeNull();
    }
    db.__tables.agent_sessions[0].status = "closed";
    await expect(findOrCreateLeasingSmsTestSession(db as never, {
      landlordId: MANAGER,
      actorUserId: ACTOR,
      targetListingId: "listing-a",
      sessionKind: `leasing_sms_test:${MANAGER}:listing-a`,
      sessionId: "session-a",
    })).resolves.toBeNull();
  });

  it("refuses ordinary or blank session kinds", async () => {
    const db = createMemoryDb({ agent_sessions: [] });
    await expect(findOrCreateLeasingSmsTestSession(db as never, {
      landlordId: MANAGER,
      actorUserId: ACTOR,
      sessionKind: "leasing_sms",
      targetListingId: "listing-a",
    })).resolves.toBeNull();
    await expect(findOrCreateLeasingSmsTestSession(db as never, {
      landlordId: MANAGER,
      actorUserId: " ",
      sessionKind: `leasing_sms_test:${MANAGER}:listing-a`,
      targetListingId: "listing-a",
    })).resolves.toBeNull();
    expect(db.__tables.agent_sessions).toHaveLength(0);
  });
});
