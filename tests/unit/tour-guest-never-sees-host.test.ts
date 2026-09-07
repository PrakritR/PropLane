/**
 * A prospect is never told who is showing them the house.
 *
 * Hosting is an internal assignment: a request belongs to nobody until someone
 * approves it, any eligible co-manager can claim it, and it may be handed to
 * another one afterwards. While guest-facing mail named the host, every one of
 * those became an outward-facing change — a handover would either send the
 * guest a correction nobody asked for, or leave them holding a name that is no
 * longer true. The guest does not care who is touring; they care when and where.
 */
import { describe, expect, it } from "vitest";
import {
  buildTourConfirmedTenantBody,
  buildTourConfirmedTenantHtml,
  buildTourRescheduledTenantBody,
  buildTourRequestManagerBody,
  type TourNotificationContext,
} from "@/lib/tour-notifications";

const HOST_NAME = "Dana Hostmanager";

const ctx: TourNotificationContext = {
  guestName: "Prospect Pat",
  guestEmail: "pat@example.com",
  propertyTitle: "Ballard House",
  propertyAddress: "5400 Ballard Ave NW",
  roomLabel: "Room 2",
  tourStartIso: "2099-08-06T17:00:00.000Z",
  tourEndIso: "2099-08-06T18:00:00.000Z",
  managerLabel: HOST_NAME,
  origin: "https://prop-lane.space",
  applyUrl: "https://prop-lane.space/rent/apply?propertyId=prop-1",
};

describe("guest-facing tour mail", () => {
  it("does not name the host when a tour is confirmed", () => {
    const body = buildTourConfirmedTenantBody(ctx);
    expect(body).not.toContain(HOST_NAME);
    expect(body).not.toContain("Host:");
    // The things they DO need are still there.
    expect(body).toContain("Ballard House");
    expect(body).toContain("Room 2");
  });

  it("does not name the host in the HTML copy either", () => {
    const html = buildTourConfirmedTenantHtml(ctx);
    expect(html).not.toContain(HOST_NAME);
    expect(html).not.toContain("Host:");
    expect(html).toContain("Ballard House");
  });

  it("does not name the host when a tour moves", () => {
    const body = buildTourRescheduledTenantBody(ctx, {
      startIso: "2099-08-05T17:00:00.000Z",
      endIso: "2099-08-05T18:00:00.000Z",
    });
    expect(body).not.toContain(HOST_NAME);
    expect(body).not.toContain("Host:");
  });
});

describe("manager-facing mail is unaffected", () => {
  it("still tells the manager who the request is for", () => {
    // The rule is about the GUEST, not about hiding assignment internally.
    const body = buildTourRequestManagerBody(ctx);
    expect(body).toContain("Ballard House");
  });
});
