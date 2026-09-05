import { beforeEach, describe, expect, it, vi } from "vitest";

const logManagerSmsMessage = vi.fn(async (): Promise<boolean> => true);

vi.mock("@/lib/manager-sms-messages.server", () => ({
  logManagerSmsMessage: (...args: unknown[]) =>
    logManagerSmsMessage(...(args as [unknown, unknown])),
}));

import { logVoiceCallStarted, logVoiceCallTurnNotes } from "@/lib/voice/log-voice-call-notes.server";

const identity = {
  managerUserId: "mgr-1",
  actorUserId: "mgr-1",
  actorPhone: "+15551234567",
  workNumber: "+15557654321",
  callSid: "CAcall1",
  counterpartyRole: "manager" as const,
};

describe("log voice call notes into Communication", () => {
  beforeEach(() => {
    logManagerSmsMessage.mockClear();
    logManagerSmsMessage.mockResolvedValue(true);
  });

  it("writes a started line, then the spoken turn and the assistant reply", async () => {
    const db = {} as never;
    await logVoiceCallStarted(db, identity);
    await logVoiceCallTurnNotes(db, {
      ...identity,
      spoken: "What tours are open Tuesday?",
      reply: "Tuesday at 2pm or 4pm.",
    });

    expect(logManagerSmsMessage).toHaveBeenCalledTimes(3);
    expect(logManagerSmsMessage.mock.calls[0][1]).toMatchObject({
      direction: "outbound",
      messageSid: "voice:CAcall1:started",
      counterpartyRole: "manager",
      body: expect.stringContaining("transcript"),
    });
    expect(logManagerSmsMessage.mock.calls[1][1]).toMatchObject({
      direction: "inbound",
      body: "What tours are open Tuesday?",
    });
    expect(String((logManagerSmsMessage.mock.calls[1][1] as { messageSid: string }).messageSid)).toMatch(
      /^voice:CAcall1:user:/,
    );
    expect(logManagerSmsMessage.mock.calls[2][1]).toMatchObject({
      direction: "outbound",
      body: "Tuesday at 2pm or 4pm.",
    });
  });
});
