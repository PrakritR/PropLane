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

import {
  fileWorkflowFromInboundEmailReply,
  fileWorkflowFromInboundMessage,
} from "@/lib/inbox/inbound-message-workflows.server";

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
 * Inbound email cannot tell which way the message is travelling on its own. A
 * portal reply token names whoever sent the ORIGINAL mail — sometimes the
 * manager, sometimes the resident — so the direction is verified rather than
 * assumed.
 */
describe("fileWorkflowFromInboundEmailReply", () => {
  const db = {} as never;

  it("files when the replier really is this owner's resident", async () => {
    const out = await fileWorkflowFromInboundEmailReply(db, {
      ownerUserId: "mgr-1",
      replierEmail: "res@example.com",
      text: "The heater is dead",
    });
    expect(out).toMatchObject({ filed: "work_order" });
  });

  it("files NOTHING when the manager is the one replying", async () => {
    // Owner is the resident here, so the replier is the manager. Filing would
    // open a work order against the manager's own words, as if they were a
    // tenant reporting a fault in their own building.
    managerIdsOwningResident.mockResolvedValue(["some-other-manager"]);
    const out = await fileWorkflowFromInboundEmailReply(db, {
      ownerUserId: "resident-user",
      replierEmail: "manager@example.com",
      text: "The heater is dead, I'll send someone",
    });
    expect(out).toEqual({ filed: "none", reason: "not_a_request" });
    expect(createWorkOrder).not.toHaveBeenCalled();
  });

  it("checks the cheap classifier before paying for the ownership read", async () => {
    await fileWorkflowFromInboundEmailReply(db, {
      ownerUserId: "mgr-1",
      replierEmail: "res@example.com",
      text: "Sounds good, thanks!",
    });
    expect(managerIdsOwningResident).not.toHaveBeenCalled();
  });

  it("files nothing when ownership cannot be established", async () => {
    // Fail closed: a missed work order is a message a human still reads, a
    // wrong one dispatches a job at somebody's cost.
    managerIdsOwningResident.mockRejectedValue(new Error("db down"));
    const out = await fileWorkflowFromInboundEmailReply(db, {
      ownerUserId: "mgr-1",
      replierEmail: "res@example.com",
      text: "The heater is dead",
    });
    expect(out).toEqual({ filed: "none", reason: "create_failed" });
    expect(createWorkOrder).not.toHaveBeenCalled();
  });
});
