import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cancelPlannedTourFromServer,
  proposePendingTourRescheduleFromServer,
  reschedulePlannedTourFromServer,
} from "@/lib/tour-planned-change.client";

afterEach(() => vi.unstubAllGlobals());

function captureRequest() {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("tour notification channel forwarding", () => {
  it("forwards explicit channel choices for cancel", async () => {
    const fetchMock = captureRequest();
    await cancelPlannedTourFromServer({
      plannedEventId: "tour-1",
      deliverViaEmail: false,
      deliverViaSms: true,
    });
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(body).toMatchObject({ deliverViaEmail: false, deliverViaSms: true });
  });

  it("forwards explicit channel choices for confirmed and pending reschedules", async () => {
    const fetchMock = captureRequest();
    await reschedulePlannedTourFromServer({
      plannedEventId: "tour-1",
      start: "2099-01-02T10:00:00.000Z",
      end: "2099-01-02T10:30:00.000Z",
      deliverViaEmail: true,
      deliverViaSms: true,
    });
    await proposePendingTourRescheduleFromServer({
      inquiryId: "inquiry-1",
      previousStart: "2099-01-01T10:00:00.000Z",
      previousEnd: "2099-01-01T10:30:00.000Z",
      start: "2099-01-02T10:00:00.000Z",
      end: "2099-01-02T10:30:00.000Z",
      deliverViaEmail: false,
      deliverViaSms: true,
    });
    const bodies = fetchMock.mock.calls.map((call) => JSON.parse(String((call[1] as RequestInit).body)));
    expect(bodies[0]).toMatchObject({ deliverViaEmail: true, deliverViaSms: true });
    expect(bodies[1]).toMatchObject({ deliverViaEmail: false, deliverViaSms: true });
  });

  it("preserves legacy server defaults when callers omit channel flags", async () => {
    const fetchMock = captureRequest();
    await cancelPlannedTourFromServer({ plannedEventId: "tour-1" });
    const body = JSON.parse(String((fetchMock.mock.calls[0]![1] as RequestInit).body));
    expect(body).not.toHaveProperty("deliverViaEmail");
    expect(body).not.toHaveProperty("deliverViaSms");
  });
});
