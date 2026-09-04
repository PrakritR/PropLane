import { describe, expect, it } from "vitest";
import { buildSmsSchedulePayloads } from "@/components/portal/pro-communication-compose-modal";

describe("manager Communication SMS scheduling", () => {
  it("creates one scheduled payload for every selected SMS target", () => {
    const payloads = buildSmsSchedulePayloads({
      targets: [
        { phone: "+12065550101", residentUserId: "resident-1" },
        { phone: "+12065550102", residentUserId: null },
      ],
      subject: "Building update",
      body: "The water will be off briefly.",
      sendAt: "2026-08-27T15:00:00.000Z",
    });

    expect(payloads).toEqual([
      expect.objectContaining({
        recipientEmail: "sms:+12065550101",
        residentUserId: "resident-1",
        deliverViaSms: true,
        deliverViaEmail: false,
      }),
      expect.objectContaining({
        recipientEmail: "sms:+12065550102",
        residentUserId: undefined,
        deliverViaSms: true,
        deliverViaEmail: false,
      }),
    ]);
  });
});
