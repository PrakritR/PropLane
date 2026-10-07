import { describe, expect, it } from "vitest";
import { buildServicePipeline, requestRowFacts } from "@/lib/service-pipeline";
import { canSendToPhone, canShareService, publishBudgetCents, sendToPhoneToast } from "@/lib/service-work-share-ui";
import type { WorkOrderVendorOffer } from "@/lib/work-order-vendor-offers";

describe("service work share UI helpers", () => {
  it("gates Send on a full phone and the attestation", () => {
    expect(canSendToPhone({ phone: "+14255550123", attestWorksWithVendor: true })).toBe(true);
    expect(canSendToPhone({ phone: "+14255550123", attestWorksWithVendor: false })).toBe(false);
    expect(canSendToPhone({ phone: "425", attestWorksWithVendor: true })).toBe(false);
  });

  it("needs the attestation only while the first text to the number still does, and never for an opted-out number", () => {
    expect(canSendToPhone({ phone: "+14255550123", attestWorksWithVendor: false, attestationNeeded: false })).toBe(true);
    expect(canSendToPhone({ phone: "+14255550123", attestWorksWithVendor: false, attestationNeeded: true })).toBe(false);
    expect(canSendToPhone({ phone: "+14255550123", attestWorksWithVendor: true, attestationNeeded: false, optedOut: true })).toBe(false);
  });

  it("parses the optional budget to cents", () => {
    expect(publishBudgetCents("")).toBeNull();
    expect(publishBudgetCents("0")).toBeNull();
    expect(publishBudgetCents("$1,250.50")).toBe(125050);
  });

  it("says a sandbox send delivered nothing", () => {
    expect(sendToPhoneToast({})).toBe("Sent");
    expect(sendToPhoneToast({ sandbox: {} })).toBe("Sent (sandbox: captured, nothing delivered)");
  });

  it("offers sharing only on an Open, unassigned, unclosed service", () => {
    expect(canShareService({ stage: "open", hasAssignee: false })).toBe(true);
    expect(canShareService({ stage: "open", hasAssignee: true })).toBe(false);
    expect(canShareService({ stage: "assigned", hasAssignee: false })).toBe(false);
    expect(canShareService({ stage: "open", hasAssignee: false, status: "Cancelled" })).toBe(false);
  });
});

describe("pipeline origin facts", () => {
  it("maps origin to a fact on both buckets and held contact on Sent only", () => {
    const vendor = { origin: "work_board", contactHeldUntilBid: true } as const;
    expect(requestRowFacts(vendor, "sent")).toEqual({ originFact: "From the work board", contactFact: "Contact shown after they bid" });
    expect(requestRowFacts(vendor, "bids")).toEqual({ originFact: "From the work board" });
    expect(requestRowFacts({ origin: "service_link" }, "bids")).toEqual({ originFact: "From your text link" });
    expect(requestRowFacts({}, "sent")).toEqual({});
    expect(requestRowFacts(undefined, "sent")).toEqual({});
  });

  it("threads the facts onto a Sent row only for a link / board vendor", () => {
    const offer = (id: string, vendorId: string, name: string) =>
      ({ id, workOrderId: "wo1", vendorDirectoryId: vendorId, vendorUserId: null, vendorName: name, status: "sent", createdAt: "2026-10-06T00:00:00Z" }) satisfies WorkOrderVendorOffer;
    const pipeline = buildServicePipeline({
      job: null,
      offers: [offer("o1", "v1", "Dima"), offer("o2", "v2", "Rainier")],
      bids: [],
      roster: [
        { id: "v1", name: "Dima", origin: "service_link" },
        { id: "v2", name: "Rainier" },
      ],
    });
    const byName = Object.fromEntries(pipeline.sent.map((row) => [row.vendorName, row]));
    expect(pipeline.sent).toHaveLength(2);
    expect(byName["Dima"].originFact).toBe("From your text link");
    expect(byName["Rainier"]).not.toHaveProperty("originFact");
  });
});
