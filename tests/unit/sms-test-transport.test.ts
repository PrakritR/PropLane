import { describe, expect, it } from "vitest";

import {
  captureSmsTestDelivery,
  currentSmsTestTransport,
  runWithSmsTestTransport,
} from "@/lib/sms/sms-test-transport.server";

describe("SMS test transport context", () => {
  it("captures delivery evidence only inside the authenticated test turn", async () => {
    expect(currentSmsTestTransport()).toBeNull();
    expect(captureSmsTestDelivery({
      kind: "sms",
      summary: "must use the live transport",
      status: "refused",
    })).toBe(false);

    const turn = await runWithSmsTestTransport(
      {
        actorUserId: "actor-1",
        managerUserId: "manager-1",
        sessionId: "session-1",
      },
      async () => {
        expect(currentSmsTestTransport()).toMatchObject({
          actorUserId: "actor-1",
          managerUserId: "manager-1",
          sessionId: "session-1",
        });
        expect(captureSmsTestDelivery({
          kind: "sms",
          summary: "Tour request receipt to the prospect",
          status: "captured",
          metadata: { purpose: "prospect_tour_followup", delayed: true },
        })).toBe(true);
        expect(captureSmsTestDelivery({
          kind: "manager_notification",
          summary: "Manager escalation",
          status: "refused",
          metadata: { reason: "unsupported_external_action" },
        })).toBe(true);
        return "reply";
      },
    );

    expect(turn).toEqual({
      result: "reply",
      effects: [
        {
          kind: "sms",
          summary: "Tour request receipt to the prospect",
          status: "captured",
          metadata: { purpose: "prospect_tour_followup", delayed: true },
        },
        {
          kind: "manager_notification",
          summary: "Manager escalation",
          status: "refused",
          metadata: { reason: "unsupported_external_action" },
        },
      ],
    });
    expect(currentSmsTestTransport()).toBeNull();
  });

  it("isolates concurrent turns and restores an outer context after nesting", async () => {
    let releaseFirst: (() => void) | undefined;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = runWithSmsTestTransport(
      { actorUserId: "actor-a", managerUserId: "manager-a" },
      async () => {
        captureSmsTestDelivery({ kind: "push", summary: "A", status: "captured" });
        await firstCanFinish;
        expect(currentSmsTestTransport()?.actorUserId).toBe("actor-a");
        return "a";
      },
    );
    const second = runWithSmsTestTransport(
      { actorUserId: "actor-b", managerUserId: "manager-b" },
      async () => {
        captureSmsTestDelivery({ kind: "email", summary: "B", status: "refused" });
        expect(currentSmsTestTransport()?.actorUserId).toBe("actor-b");
        releaseFirst?.();
        return "b";
      },
    );

    const [a, b] = await Promise.all([first, second]);
    expect(a.effects).toEqual([{ kind: "push", summary: "A", status: "captured" }]);
    expect(b.effects).toEqual([{ kind: "email", summary: "B", status: "refused" }]);

    await runWithSmsTestTransport(
      { actorUserId: "outer", managerUserId: "manager" },
      async () => {
        const inner = await runWithSmsTestTransport(
          { actorUserId: "inner", managerUserId: "manager" },
          async () => {
            captureSmsTestDelivery({ kind: "calendar", summary: "inner", status: "captured" });
            return null;
          },
        );
        expect(inner.effects).toHaveLength(1);
        expect(currentSmsTestTransport()?.actorUserId).toBe("outer");
        captureSmsTestDelivery({ kind: "reminder", summary: "outer", status: "captured" });
        return null;
      },
    ).then(({ effects }) => {
      expect(effects).toEqual([{ kind: "reminder", summary: "outer", status: "captured" }]);
    });
  });
});
