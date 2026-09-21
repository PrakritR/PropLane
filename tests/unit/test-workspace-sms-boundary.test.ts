import { describe, expect, it } from "vitest";

import {
  preserveStoredSmsTestProvenance,
  sameSmsTestProvenance,
  withSmsTestProvenance,
} from "@/lib/sms/sms-test-provenance";
import {
  captureSmsTestDelivery,
  currentSmsTestTransport,
  runWithSmsTestTransport,
} from "@/lib/sms/sms-test-transport.server";

const ACTOR = "11111111-1111-4111-8111-111111111111";
const MANAGER = "22222222-2222-4222-8222-222222222222";
const WORKSPACE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const WORKSPACE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

type WorkspaceProvenance = {
  actorUserId: string;
  managerUserId: string;
  sessionId: string;
  workspaceId: string;
};

type WorkspaceTransportIdentity = {
  actorUserId: string;
  managerUserId: string;
  sessionId: string;
  workspaceId: string;
};

describe("authenticated SMS test workspace boundary", () => {
  it("keeps workspace identity in the request-local transport and every captured effect", async () => {
    const result = await runWithSmsTestTransport(
      {
        actorUserId: ACTOR,
        managerUserId: MANAGER,
        sessionId: "session-a",
        workspaceId: WORKSPACE_A,
      } as WorkspaceTransportIdentity,
      async () => {
        expect(currentSmsTestTransport()).toMatchObject({
          actorUserId: ACTOR,
          managerUserId: MANAGER,
          sessionId: "session-a",
          workspaceId: WORKSPACE_A,
        });
        expect(captureSmsTestDelivery({
          kind: "sms",
          status: "captured",
          summary: "captured test reply",
        })).toBe(true);
      },
    );

    expect(result.effects).toEqual([
      expect.objectContaining({
        kind: "sms",
        status: "captured",
        workspaceId: WORKSPACE_A,
      }),
    ]);
  });

  it("treats workspace as part of durable provenance, so a foreign workspace cannot match", () => {
    const first = {
      actorUserId: ACTOR,
      managerUserId: MANAGER,
      sessionId: "session-a",
      workspaceId: WORKSPACE_A,
    } satisfies WorkspaceProvenance;
    const foreign = { ...first, workspaceId: WORKSPACE_B };

    expect(sameSmsTestProvenance(first as never, first as never)).toBe(true);
    expect(sameSmsTestProvenance(first as never, foreign as never)).toBe(false);
  });

  it("preserves server workspace provenance while rejecting client-authored identity", () => {
    const server = {
      actorUserId: ACTOR,
      managerUserId: MANAGER,
      sessionId: "session-a",
      workspaceId: WORKSPACE_A,
    } satisfies WorkspaceProvenance;

    expect(preserveStoredSmsTestProvenance(
      {
        id: "record-a",
        smsTestSessionId: "forged-session",
        smsTestProvenance: {
          ...server,
          workspaceId: WORKSPACE_B,
        },
      },
      { smsTestProvenance: server },
    )).toMatchObject({
      id: "record-a",
      smsTestProvenance: server,
      smsTestSessionId: "session-a",
    });
  });

  it("does not classify an ordinary control path when no authenticated test context exists", () => {
    const ordinary = { id: "normal-record", status: "pending" };
    expect(withSmsTestProvenance(ordinary, null)).toEqual(ordinary);
    expect(currentSmsTestTransport()).toBeNull();
    expect(captureSmsTestDelivery({
      kind: "sms",
      status: "captured",
      summary: "ordinary control",
    })).toBe(false);
  });
});
