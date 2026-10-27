import { describe, expect, it } from "vitest";
import {
  buildTourNotificationContext,
  buildTourRequestManagerBody,
  buildTourRequestedTimeHeadline,
} from "@/lib/tour-notifications";

const base = {
  origin: "https://proplane.test",
  guestName: "Prakrit",
  guestEmail: "p@example.com",
  propertyId: "prop-1",
  propertyTitle: "2412 Clifford St",
  tourStartIso: "2026-10-29T23:00:00.000Z",
  tourEndIso: "2026-10-29T23:30:00.000Z",
};

describe("manager notice for a requested time", () => {
  it("reads '<Name> wants to tour <property> on <Day, Mon D> at <h:mm AM/PM>'", () => {
    const ctx = buildTourNotificationContext({ ...base, requestedTime: true });
    expect(buildTourRequestedTimeHeadline(ctx)).toBe("Prakrit wants to tour 2412 Clifford St on Thu, Oct 29 at 4:00 PM");
    expect(buildTourRequestManagerBody(ctx)).toContain("Prakrit wants to tour 2412 Clifford St on Thu, Oct 29 at 4:00 PM.");
  });

  it("keeps the standard request copy for a published slot", () => {
    const body = buildTourRequestManagerBody(buildTourNotificationContext(base));
    expect(body).toContain("Someone requested a property tour through PropLane.");
    expect(body).not.toContain("wants to tour");
  });
});
