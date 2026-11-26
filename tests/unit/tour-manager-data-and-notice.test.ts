import { describe, expect, it } from "vitest";
import {
  managerTourRowFromProposal,
  tourInquirySummaryForProposal,
  type TourProposalListItem,
} from "@/lib/manager-tour-proposal-rows";
import { tourRowsFromInquiries } from "@/lib/manager-tour-list";
import {
  buildTourNotificationContext,
  buildTourRequestManagerBody,
  buildTourRequestManagerSms,
  buildTourRequestTenantBody,
  managerTourRequestDeepLink,
  tourConfirmationReference,
} from "@/lib/tour-notifications";
import { managerTourDetailHref } from "@/lib/portal-detail-routes";
import type { PartnerInquiry } from "@/lib/demo-admin-scheduling";

const ID = "3f9a2c1e-7b44-4d0e-9a55-0123456789ab";
// Sat Nov 21 2026, 2:00 PM Pacific = 22:00Z.
const START = "2026-11-21T22:00:00.000Z";
const END = "2026-11-21T22:30:00.000Z";

const inquiry: PartnerInquiry = {
  id: ID,
  name: "QA Test Prospect",
  email: "qa@example.com",
  phone: "+12065550100",
  notes: "",
  kind: "tour",
  propertyId: "prop-5257",
  propertyTitle: "5257 Brooklyn",
  roomLabel: "Room 6",
  proposedStart: START,
  proposedEnd: END,
  status: "pending",
  createdAt: "2026-11-19T00:00:00.000Z",
};

describe("manager Tours reads the saved tour (A1)", () => {
  it("maps a saved inquiry row to the list row with the booked values", () => {
    const [row] = tourRowsFromInquiries([inquiry]);
    expect(row).toMatchObject({
      guestName: "QA Test Prospect",
      guestEmail: "qa@example.com",
      guestPhone: "+12065550100",
      propertyTitle: "5257 Brooklyn",
      roomLabel: "Room 6",
      statusLabel: "Pending",
    });
    expect(row!.whenLabel).not.toBe("");
  });

  it("a proposal row takes the contact and house from the saved inquiry, not placeholders", () => {
    const proposal: TourProposalListItem = {
      id: "act-1",
      inquiryId: ID,
      startIso: START,
      endIso: END,
      preview: { title: "Confirm tour", fields: [] },
      inquiry: tourInquirySummaryForProposal(inquiry as unknown as Record<string, unknown>),
      createdAt: "2026-11-19T00:00:00.000Z",
    };
    const row = managerTourRowFromProposal(proposal, null)!;
    expect(row.guestName).toBe("QA Test Prospect");
    expect(row.guestEmail).toBe("qa@example.com");
    expect(row.guestPhone).toBe("+12065550100");
    expect(row.propertyTitle).toBe("5257 Brooklyn");
    expect(row.propertyId).toBe("prop-5257");
    expect(row.roomLabel).toBe("Room 6");
  });

  it("falls back to the visible inquiry row, then the preview, before any placeholder", () => {
    const [inq] = tourRowsFromInquiries([inquiry]);
    const bare: TourProposalListItem = {
      id: "act-2", inquiryId: ID, startIso: START, endIso: END,
      preview: { title: "x", fields: [{ label: "Guest", value: "Preview Name" }] },
      createdAt: "",
    };
    expect(managerTourRowFromProposal(bare, inq!)!.guestEmail).toBe("qa@example.com");
    expect(managerTourRowFromProposal(bare, inq!)!.propertyTitle).toBe("5257 Brooklyn");
    expect(managerTourRowFromProposal(bare, null)!.guestName).toBe("Preview Name");
    expect(managerTourRowFromProposal(bare, null)!.propertyTitle).toBe("Property");
  });
});

describe("manager tour-request notification (A3)", () => {
  const ctx = buildTourNotificationContext({
    origin: "https://proplane.ai",
    guestName: "QA Test Prospect",
    guestEmail: "qa@example.com",
    guestPhone: "+12065550100",
    propertyId: "prop-5257",
    propertyTitle: "5257 Brooklyn",
    propertyAddress: "5257 Brooklyn Ave NE, Seattle",
    roomLabel: "Room 6",
    tourStartIso: START,
    tourEndIso: END,
    tourInquiryId: ID,
  });

  it("the text carries name, property + room, date AND time in Pacific, and the deep link", () => {
    const sms = buildTourRequestManagerSms(ctx);
    expect(sms).toContain("QA Test Prospect");
    expect(sms).toContain("5257 Brooklyn - Room 6");
    expect(sms).toContain("Sat, Nov 21, 2026");
    expect(sms).toContain("2:00 PM PT");
    expect(sms).toContain(managerTourRequestDeepLink("https://proplane.ai", ID));
  });

  it("drops the whole link sentence when the tour has no detail URL, rather than a dangling \"Open it:\"", () => {
    const noLink = buildTourNotificationContext({
      origin: "https://proplane.ai",
      guestName: "QA Test Prospect",
      guestEmail: "qa@example.com",
      propertyId: "prop-5257",
      propertyTitle: "5257 Brooklyn",
      tourStartIso: START,
      tourEndIso: END,
    });
    const sms = buildTourRequestManagerSms(noLink);
    expect(noLink.tourDetailUrl ?? "").toBe("");
    expect(sms).not.toContain("Open it");
    expect(sms.endsWith(".")).toBe(true);
  });

  it("the email body carries the same five facts", () => {
    const body = buildTourRequestManagerBody(ctx);
    expect(body).toContain("QA Test Prospect");
    expect(body).toContain("5257 Brooklyn");
    expect(body).toContain("Room 6");
    expect(body).toContain("2:00 PM PT");
    expect(body).toContain("https://proplane.ai/portal/tours/pending/inquiry-");
  });

  it("the deep link is the Tours detail route for the request's first window row", () => {
    const row = tourRowsFromInquiries([inquiry])[0]!;
    expect(managerTourRequestDeepLink("https://proplane.ai/", ID)).toBe(
      `https://proplane.ai${managerTourDetailHref("/portal", "pending", row.id)}`,
    );
  });

  // Oracle: Crockford base32 (the alphabet without I, L, O and U, so a code read aloud cannot become another one)
  // plus this reference's own contract - a label a person quotes back, never a lookup key. Plausible wrong behaviour
  // this rejects: printing the head of the record id, which is half an id and shared one code between any two tours
  // whose ids start alike.
  it("the guest confirmation carries the reference, time, property, room and address", () => {
    const ref = tourConfirmationReference(ID);
    expect(ref).toMatch(/^T-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
    expect(tourConfirmationReference(ID)).toBe(ref);
    expect(ref).not.toContain(ID.slice(0, 4).toUpperCase());
    expect(tourConfirmationReference(`${ID.slice(0, -1)}c`)).not.toBe(ref);
    expect(tourConfirmationReference("")).toBe("");
    const body = buildTourRequestTenantBody(ctx);
    expect(body).toContain(`Reference: ${ref}`);
    expect(body).toContain("5257 Brooklyn");
    expect(body).toContain("Room 6");
    expect(body).toContain("5257 Brooklyn Ave NE, Seattle");
  });
});
