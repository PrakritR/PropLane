import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ emit: vi.fn(), off: vi.fn(), isOff: vi.fn() }));
vi.mock("@/lib/action-events.server", async (importOriginal) => ({ ...(await importOriginal<object>()), emitActionEvent: h.emit }));
vi.mock("@/lib/automations/store.server", () => ({
  loadOffPresetResolver: async (...args: unknown[]) => {
    h.off(...args);
    return { isOff: h.isOff };
  },
}));
vi.mock("@/lib/webhooks/outbound.server", () => ({ enqueueWebhookEvent: vi.fn(async () => undefined) }), { });

import { workOrderEvent } from "@/lib/work-order-events.server";

const base = (event: string, recipients: Array<{ audience: string; userId?: string }>) => ({
  eventId: `e-${event}`, event, managerUserId: "owner", workOrderId: "wo1", senderUserId: "owner", senderEmail: "o@x.com",
  facts: { reference: "S-1", title: "Sink", propertyId: "P1", scheduledFor: "Tue 10-12" }, recipients,
}) as never;

beforeEach(() => {
  h.emit.mockReset().mockResolvedValue({ eventId: "e", duplicate: false, delivered: 1, deferred: 0, failed: 0 });
  h.off.mockReset();
  h.isOff.mockReset().mockReturnValue(false);
});

describe("Service visit booked switched off in Settings -> Automations", () => {
  it("stops telling the resident, and still tells the manager", async () => {
    h.isOff.mockReturnValue(true);
    await workOrderEvent({} as never, base("scheduled", [{ audience: "resident" }, { audience: "manager" }]));
    const sent = h.emit.mock.calls[0]![1].recipients.map((r: { audience: string }) => r.audience);
    expect(sent).toEqual(["manager"]);
    expect(h.isOff).toHaveBeenCalledWith("maintenance_booked", "P1");
  });

  it("changes nothing while the preset is on (today's behaviour)", async () => {
    await workOrderEvent({} as never, base("rescheduled", [{ audience: "resident" }, { audience: "manager" }]));
    expect(h.emit.mock.calls[0]![1].recipients.map((r: { audience: string }) => r.audience)).toEqual(["resident", "manager"]);
  });

  it("does not even look the setting up for other events or when no resident would hear", async () => {
    await workOrderEvent({} as never, base("completed", [{ audience: "resident" }]));
    await workOrderEvent({} as never, base("scheduled", [{ audience: "manager" }]));
    expect(h.off).not.toHaveBeenCalled();
  });
});
