import { describe, expect, it } from "vitest";
import {
  hasSmsTestProvenance,
  readSmsTestProvenance,
  sameSmsTestProvenance,
  preserveStoredSmsTestProvenance,
  withSmsTestProvenance,
  type SmsTestProvenance,
} from "@/lib/sms/sms-test-provenance";

const provenance: SmsTestProvenance = {
  actorUserId: "actor-1",
  managerUserId: "manager-1",
  sessionId: "session-1",
};

describe("SMS test provenance", () => {
  it("reads the nested marker and the legacy flat aliases", () => {
    expect(readSmsTestProvenance({ smsTestProvenance: provenance })).toEqual(provenance);
    expect(readSmsTestProvenance({
      sms_test_actor_user_id: "actor-1",
      sms_test_manager_user_id: "manager-1",
      sms_test_session_id: "session-1",
    })).toEqual(provenance);
    expect(readSmsTestProvenance({ smsTestSessionId: "session-1" })).toEqual({
      actorUserId: "",
      managerUserId: "",
      sessionId: "session-1",
    });
    expect(hasSmsTestProvenance({ smsTestSessionId: "session-1" })).toBe(true);
    expect(hasSmsTestProvenance({ smsTestSessionId: "" })).toBe(false);
  });

  it("keeps an existing session immutable while filling missing identity fields", () => {
    const value = { id: "row-1", smsTestSessionId: "old-session" };
    const result = withSmsTestProvenance(value, provenance);

    expect(result).toEqual({
      id: "row-1",
      smsTestSessionId: "old-session",
      smsTestProvenance: {
        actorUserId: "actor-1",
        managerUserId: "manager-1",
        sessionId: "old-session",
      },
    });
    expect(value).toEqual({ id: "row-1", smsTestSessionId: "old-session" });
  });

  it("requires all three identity parts for an exact match", () => {
    expect(sameSmsTestProvenance(provenance, { ...provenance })).toBe(true);
    expect(sameSmsTestProvenance(provenance, { ...provenance, managerUserId: "other-manager" })).toBe(false);
    expect(sameSmsTestProvenance(provenance, null)).toBe(false);
  });

  it("preserves only server-stored provenance across a client replacement", () => {
    expect(preserveStoredSmsTestProvenance(
      { id: "row-1", smsTestSessionId: "forged" },
      { smsTestProvenance: provenance },
    )).toEqual({ id: "row-1", smsTestSessionId: "session-1", smsTestProvenance: provenance });
    expect(preserveStoredSmsTestProvenance(
      {
        id: "row-1",
        smsTestSessionId: "forged",
        smsTestProvenance: provenance,
        sms_test_actor_user_id: "forged",
        sms_test_manager_user_id: "forged",
        sms_test_session_id: "forged",
        test_actor_user_id: "forged",
        test_session_id: "forged",
      },
      {},
    )).toEqual({ id: "row-1" });
  });
});
