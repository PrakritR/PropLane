import { describe, expect, it } from "vitest";
import { leasingSmsTraceActor } from "@/lib/agent/leasing-sms-agent.server";
import { residentSmsTraceActor } from "@/lib/agent/resident-sms-agent.server";
import { vendorWorkOrderTraceActor } from "@/lib/agent/vendor-agent.server";
import type { ResidentAgentContext } from "@/lib/tools/resident-context";

const MANAGER = "11111111-1111-4111-8111-111111111111";
const RESIDENT = "22222222-2222-4222-8222-222222222222";

describe("SMS agent trace attribution", () => {
  it("attributes resident turns to the resident and active work-number owner without PII", () => {
    const actor = residentSmsTraceActor({
      userId: RESIDENT,
      landlordId: RESIDENT,
      activeManagerId: MANAGER,
    } as ResidentAgentContext, MANAGER);

    expect(actor).toEqual({
      userId: RESIDENT,
      metadata: {
        landlordId: RESIDENT,
        role: "resident",
        managerIds: [MANAGER],
        activeManagerId: MANAGER,
        channel: "sms",
      },
    });
    expect(JSON.stringify(actor)).not.toMatch(/phone|email|message|content/i);
  });

  it("attributes prospect turns to the work-number owner without prospect PII", () => {
    const actor = leasingSmsTraceActor(MANAGER);

    expect(actor).toEqual({
      userId: MANAGER,
      metadata: {
        landlordId: MANAGER,
        role: "prospect",
        managerIds: [MANAGER],
        channel: "sms",
      },
    });
    expect(JSON.stringify(actor)).not.toMatch(/phone|email|message|content/i);
  });

  it("attributes vendor job turns to the vendor and owning manager without PII", () => {
    const actor = vendorWorkOrderTraceActor({
      id: "session-id",
      landlord_id: MANAGER,
      kind: "vendor_work_order",
      vendor_user_id: "33333333-3333-4333-8333-333333333333",
      vendor_directory_id: "vendor-directory-id",
      work_order_id: "work-order-id",
      vendor_phone_e164: null,
      status: "active",
      inbox_thread_id: null,
    }, "sms");

    expect(actor).toEqual({
      userId: "33333333-3333-4333-8333-333333333333",
      metadata: {
        landlordId: MANAGER,
        role: "vendor",
        managerIds: [MANAGER],
        channel: "sms",
      },
    });
    expect(JSON.stringify(actor)).not.toMatch(/phone|email|message|content/i);
  });
});
