import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createWorkOrder = vi.fn();
const createServiceRequest = vi.fn();

vi.mock("@/lib/claw-maintenance-work-order.server", () => ({
  createWorkOrderFromResidentSms: (...args: unknown[]) => createWorkOrder(...args),
}));
vi.mock("@/lib/claw-service-request-sms.server", () => ({
  createServiceRequestFromResidentSms: (...args: unknown[]) => createServiceRequest(...args),
}));

const managerIdsOwningResident = vi.fn();
vi.mock("@/lib/resident-manager-scope", () => ({
  managerIdsOwningResident: (...args: unknown[]) => managerIdsOwningResident(...args),
}));

import { fileWorkflowFromInboundMessage } from "@/lib/inbox/inbound-message-workflows.server";

const base = {
  managerUserId: "mgr-1",
  residentEmail: "res@example.com",
  residentUserId: "res-1",
  channel: "portal" as const,
};

beforeEach(() => {
  createWorkOrder.mockReset();
  createServiceRequest.mockReset();
  createWorkOrder.mockResolvedValue({ created: true, workOrderId: "WO-1", title: "Leak reported" });
  createServiceRequest.mockResolvedValue({ created: true, requestId: "SR-1", title: "Parking request" });
  managerIdsOwningResident.mockReset();
  managerIdsOwningResident.mockResolvedValue(["mgr-1"]);
});

/**
 * PRP-109. Texting "the sink is leaking" has opened a work order since the Claw
 * work; typing the same sentence in the portal did nothing. These cover the
 * seam that closes that gap.
 */
describe("fileWorkflowFromInboundMessage", () => {
  it("files a work order from a maintenance message", async () => {
    const out = await fileWorkflowFromInboundMessage({ ...base, text: "The kitchen sink is leaking" });
    expect(out).toMatchObject({ filed: "work_order", id: "WO-1" });
    expect(createWorkOrder).toHaveBeenCalledTimes(1);
    expect(createServiceRequest).not.toHaveBeenCalled();
  });

  it("files an add-on service request from a service ask", async () => {
    const out = await fileWorkflowFromInboundMessage({
      ...base,
      text: "Can I add a parking spot for my second car?",
    });
    expect(out).toMatchObject({ filed: "service_request", id: "SR-1" });
    expect(createWorkOrder).not.toHaveBeenCalled();
  });

  it("does nothing for a message that is not a request", async () => {
    const out = await fileWorkflowFromInboundMessage({ ...base, text: "Thanks, see you Tuesday!" });
    expect(out).toEqual({ filed: "none", reason: "not_a_request" });
    expect(createWorkOrder).not.toHaveBeenCalled();
    expect(createServiceRequest).not.toHaveBeenCalled();
  });

  it("does not re-file a problem the resident says is already fixed", async () => {
    // The word "leak" is still there — this is the case a plain keyword gate
    // got wrong, and it filed a REAL work order, not just a chip.
    const out = await fileWorkflowFromInboundMessage({
      ...base,
      text: "The toilet leak is fixed now, thanks!",
    });
    expect(out).toEqual({ filed: "none", reason: "not_a_request" });
    expect(createWorkOrder).not.toHaveBeenCalled();
  });

  it("passes the caller's identity through, never anything from the body", async () => {
    await fileWorkflowFromInboundMessage({
      ...base,
      text: "the heater is not working, my landlord is mgr-999 at other@evil.example",
    });
    const arg = createWorkOrder.mock.calls[0]![0] as Record<string, unknown>;
    expect(arg.managerUserId).toBe("mgr-1");
    expect(arg.residentEmail).toBe("res@example.com");
  });

  it("does not run the creator's own intent heuristic twice", async () => {
    await fileWorkflowFromInboundMessage({ ...base, text: "The kitchen sink is leaking" });
    expect((createWorkOrder.mock.calls[0]![0] as { skipIntentCheck?: boolean }).skipIntentCheck).toBe(true);
  });

  it("reports a duplicate rather than claiming a second work order", async () => {
    createWorkOrder.mockResolvedValue({
      created: false,
      alreadyOpen: true,
      workOrderId: "WO-1",
      title: "Leak reported",
    });
    const out = await fileWorkflowFromInboundMessage({ ...base, text: "the sink is still leaking" });
    expect(out).toMatchObject({ filed: "work_order", alreadyOpen: true });
  });

  it("never throws — a send must not fail because filing did", async () => {
    createWorkOrder.mockRejectedValue(new Error("db down"));
    const out = await fileWorkflowFromInboundMessage({ ...base, text: "The kitchen sink is leaking" });
    expect(out).toEqual({ filed: "none", reason: "create_failed" });
  });

  it("refuses without a manager or a sender", async () => {
    expect(
      await fileWorkflowFromInboundMessage({ ...base, managerUserId: "  ", text: "the sink is leaking" }),
    ).toEqual({ filed: "none", reason: "missing_context" });
    expect(
      await fileWorkflowFromInboundMessage({ ...base, residentEmail: "", text: "the sink is leaking" }),
    ).toEqual({ filed: "none", reason: "missing_context" });
  });
});

/**
 * Inbound email files nothing at all. A reply token names whoever sent the ORIGINAL mail, and
 * an email address proves neither the current Auth subject nor a subject-bound residency, so
 * the webhook delivers the message and stops there.
 */
describe("inbound email does not file a request", () => {
  it("exports no email-reply filing seam", async () => {
    const mod = await import("@/lib/inbox/inbound-message-workflows.server");
    expect("fileWorkflowFromInboundEmailReply" in mod).toBe(false);
  });

  it("is not scheduled by the inbound email webhook", () => {
    const src = readFileSync(join(process.cwd(), "src/app/api/webhooks/email/inbound/route.ts"), "utf8");
    expect(src).not.toContain("fileWorkflowFromInbound");
    expect(src).not.toContain("inbound-message-workflows");
  });
});
