/**
 * "Application before a tour" — the server half. The rule is re-derived from the property's
 * owner, the owner's saved setting and the VERIFIED applicant email; nothing in a request body can
 * satisfy it. A manager scheduling a tour never reaches this code.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/sms-consent", () => ({ recordOptIn: async () => undefined }));
vi.mock("@/lib/public-tour-booking-guard", () => ({
  adminHasPublishedSlot: async () => true,
  managerHasPublishedSlot: async () => true,
  managerMayHostPropertyTour: async () => true,
}));
vi.mock("@/lib/tour-notification-delivery.server", () => ({
  notifyManagerTourRequest: async () => undefined,
  notifyTenantTourRequestReceived: async () => undefined,
}));
vi.mock("@/lib/payment-automation-settings", () => ({
  loadManagerAutomationSettings: async () => ({ proposeTourConfirmations: false }),
}));
vi.mock("@/lib/tour-proposal.server", () => ({ proposeTourConfirmation: async () => undefined }));
vi.mock("@/lib/manager-default-tasks.server", () => ({ createApproveTourRequestTask: async () => undefined }));
vi.mock("@/lib/tour-host-enumeration.server", () => ({ listPropertyTourHostUserIds: async () => [] }));

let pipelineRow: Record<string, unknown> | null;
let applicationRows: { row_data: unknown }[];
const upserts: unknown[] = [];

function fakeDb() {
  return {
    from(table: string) {
      const state: { table: string } = { table };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => {
          if (state.table === "manager_property_records") return { data: { manager_user_id: "owner-1" }, error: null };
          if (state.table === "manager_automation_settings") return { data: pipelineRow ? { row_data: pipelineRow } : null, error: null };
          return { data: null, error: null };
        },
        upsert: async (records: unknown) => {
          upserts.push(records);
          return { error: null };
        },
        then(resolve: (v: { data: unknown[]; error: null }) => unknown) {
          const data = state.table === "manager_application_records" ? applicationRows : [];
          return Promise.resolve({ data, error: null }).then(resolve);
        },
      };
      return builder;
    },
  } as never;
}

import {
  APPLICATION_BEFORE_TOUR_MESSAGE,
  applicationBeforeTourRefusal,
  hasSubmittedApplicationForProperty,
  resolveApplicationBeforeTour,
} from "@/lib/application-before-tour.server";
import { createTourInquiry } from "@/lib/tour-inquiry-create.server";

const submitted = (propertyId: string, extra: Record<string, unknown> = {}) => ({
  row_data: { id: "APP-1", stage: "Submitted", bucket: "pending", propertyId, ...extra },
});

beforeEach(() => {
  pipelineRow = { leasingPipeline: { applicationBeforeTour: "required" } };
  applicationRows = [];
  upserts.length = 0;
});

describe("hasSubmittedApplicationForProperty", () => {
  it("counts a submitted application for exactly that property", () => {
    expect(hasSubmittedApplicationForProperty([submitted("prop-1")], "prop-1")).toBe(true);
    expect(hasSubmittedApplicationForProperty([{ row_data: { stage: "Submitted", application: { propertyId: "prop-1" } } }], "prop-1")).toBe(true);
    expect(hasSubmittedApplicationForProperty([submitted("prop-2")], "prop-1")).toBe(false);
    expect(hasSubmittedApplicationForProperty([], "prop-1")).toBe(false);
  });

  it("does not count a draft, a withdrawn application or the booking-residency plumbing row", () => {
    expect(hasSubmittedApplicationForProperty([submitted("prop-1", { stage: "In progress" })], "prop-1")).toBe(false);
    expect(hasSubmittedApplicationForProperty([submitted("prop-1", { withdrawnAt: "2026-10-01T00:00:00Z" })], "prop-1")).toBe(false);
    expect(hasSubmittedApplicationForProperty([submitted("prop-1", { bookingResidency: true })], "prop-1")).toBe(false);
  });
});

describe("resolveApplicationBeforeTour", () => {
  it("is not required by default (Not needed), whatever applications exist", async () => {
    pipelineRow = null;
    expect(await resolveApplicationBeforeTour(fakeDb(), { propertyId: "prop-1", verifiedEmail: null })).toEqual({ required: false });
    pipelineRow = { leasingPipeline: { applicationBeforeTour: "not_needed" } };
    expect(await applicationBeforeTourRefusal(fakeDb(), { propertyId: "prop-1", verifiedEmail: null })).toBeNull();
  });

  it("when Required, an anonymous caller (no verified email) has no application", async () => {
    applicationRows = [submitted("prop-1")];
    expect(await resolveApplicationBeforeTour(fakeDb(), { propertyId: "prop-1", verifiedEmail: null })).toMatchObject({
      required: true,
      hasApplication: false,
    });
    expect(await applicationBeforeTourRefusal(fakeDb(), { propertyId: "prop-1", verifiedEmail: null })).toBe(APPLICATION_BEFORE_TOUR_MESSAGE);
  });

  it("when Required, a verified email with a submitted application for the property passes; for another property it does not", async () => {
    applicationRows = [submitted("prop-1")];
    expect(await applicationBeforeTourRefusal(fakeDb(), { propertyId: "prop-1", verifiedEmail: "Jane@Example.com" })).toBeNull();
    expect(await applicationBeforeTourRefusal(fakeDb(), { propertyId: "prop-9", verifiedEmail: "jane@example.com" })).toBe(APPLICATION_BEFORE_TOUR_MESSAGE);
  });
});

describe("createTourInquiry — the booking route's gate", () => {
  const request = (email: string) => ({
    kind: "tour",
    name: "Jane Guest",
    email,
    phone: "2065550123",
    managerUserId: "mgr-1",
    propertyId: "prop-1",
    requestedWindows: [{ start: "2026-09-07T16:00:00.000Z", end: "2026-09-07T16:30:00.000Z", adminUserId: "mgr-1", slotKey: "2026-09-07:18" }],
    proposedStart: "2026-09-07T16:00:00.000Z",
    proposedEnd: "2026-09-07T16:30:00.000Z",
  });

  it("refuses with a clear message when Required and the caller is not a verified applicant, even if the body's email has an application", async () => {
    applicationRows = [submitted("prop-1")];
    const result = await createTourInquiry(fakeDb(), { incoming: request("jane@example.com") });
    expect(result).toEqual({ ok: false, reason: "application_required", error: APPLICATION_BEFORE_TOUR_MESSAGE });
    expect(upserts).toHaveLength(0);
  });

  it("refuses a verified account that has not applied for this property", async () => {
    applicationRows = [submitted("another-property")];
    const result = await createTourInquiry(fakeDb(), { incoming: request("jane@example.com"), verifiedApplicantEmail: "jane@example.com" });
    expect(result).toMatchObject({ ok: false, reason: "application_required" });
  });

  it("books (files the request) for a verified applicant who has applied", async () => {
    applicationRows = [submitted("prop-1")];
    const result = await createTourInquiry(fakeDb(), { incoming: request("jane@example.com"), verifiedApplicantEmail: "jane@example.com" });
    expect(result.ok).toBe(true);
    expect(upserts.length).toBeGreaterThan(0);
  });

  it("changes nothing when the setting is Not needed", async () => {
    pipelineRow = { leasingPipeline: { applicationBeforeTour: "not_needed" } };
    const result = await createTourInquiry(fakeDb(), { incoming: request("jane@example.com") });
    expect(result.ok).toBe(true);
  });

  it("does not gate a partner meeting (not a property tour)", async () => {
    const result = await createTourInquiry(fakeDb(), {
      incoming: { ...request("jane@example.com"), kind: "partner", propertyId: undefined },
    });
    expect((result as { reason?: string }).reason).not.toBe("application_required");
  });
});
