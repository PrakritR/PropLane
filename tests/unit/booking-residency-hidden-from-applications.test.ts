/**
 * A booking's plumbing row (`sendBookingResidentInvite`,
 * src/lib/booking-resident-invite.server.ts) creates a
 * `manager_application_records` row tagged `row_data.bookingResidency: true`
 * so the resident-setup link has an application id to hang off of. It is
 * never a real submitted application and must never surface as one on the
 * MANAGER side: not in the Applications list, not in its "Pending" tab count,
 * not in the sidebar nav badge / dashboard "needs attention" count, not in
 * the applications reminder sweep, and not to the AI assistant's
 * `list_applications` tool.
 *
 * `isBookingResidencyRow` (src/lib/manager-applications-storage.ts) is the one
 * shared predicate every one of those readers uses.
 */
import { describe, expect, it, vi } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import {
  isBookingResidencyRow,
  isDraftApplicationRow,
} from "@/lib/manager-applications-storage";
import { isSubmittedPendingApplicationRow } from "@/lib/rental-application/in-progress-application";
import { listApplicationsTool } from "@/lib/tools/domains/applications";
import { makeManagerRowsCtx, managerRow } from "./tools/fake-agent-ctx";

const materialize = vi.fn(() => Promise.resolve(1));

vi.mock("@/lib/app-url", () => ({ resolveEmailLinkBaseUrl: () => "https://prop-lane.space" }));
vi.mock("@/lib/reminders/queue.server", () => ({
  materializeReminders: (...args: unknown[]) => materialize(...(args as [])),
}));
vi.mock("@/lib/reminders/manager-recipients.server", () => ({
  loadManagerReminderRecipients: () =>
    Promise.resolve(new Map([["mgr-1", { email: "manager@example.com", name: "Morgan" }]])),
  loadTeamReminderRecipients: () => Promise.resolve([]),
  teamReminderRecipients: () => [],
}));
vi.mock("@/lib/reminders/settings.server", () => ({
  loadReminderSettingsResolver: () =>
    Promise.resolve({
      resolve: () => ({
        rules: {
          application: { enabled: true, teamUserIds: [] },
          application_manager: { enabled: true, teamUserIds: [] },
        },
      }),
    }),
}));

import { sweepApplicationReminders } from "@/lib/reminders/subjects/applications.server";

/** Shaped exactly like `sendBookingResidentInvite`'s stored row. */
function bookingResidencyRow(overrides: Partial<DemoApplicantRow> = {}): DemoApplicantRow {
  return {
    id: "PROPLANE-BOOK1",
    name: "Casey Booking",
    email: "booking.proplanebook1@import.proplane.local",
    property: "Ash Flats 6",
    propertyId: "mgr-house-1",
    assignedPropertyId: "mgr-house-1",
    managerUserId: "mgr-1",
    stage: "Booking",
    bucket: "pending",
    detail: "Booking · Ash Flats 6",
    manuallyAdded: true,
    bookingResidency: true,
    bookingBlockId: "block-1",
    ...overrides,
  } as DemoApplicantRow;
}

/** A real submitted application, otherwise shaped the same. */
function submittedApplicationRow(overrides: Partial<DemoApplicantRow> = {}): DemoApplicantRow {
  return {
    id: "PROPLANE-REAL1",
    name: "Real Applicant",
    email: "real.applicant@example.com",
    property: "Ash Flats 6",
    propertyId: "mgr-house-1",
    assignedPropertyId: "mgr-house-1",
    managerUserId: "mgr-1",
    stage: "Submitted",
    bucket: "pending",
    detail: "Submitted",
    ...overrides,
  } as DemoApplicantRow;
}

/** A real (non-booking) unsubmitted draft — the control case for the reminder sweep. */
function inProgressDraftRow(): DemoApplicantRow {
  return {
    id: "PROPLANE-DRAFT1",
    name: "Drafty Draft",
    email: "drafty@example.com",
    property: "Ash Flats 6",
    propertyId: "mgr-house-1",
    assignedPropertyId: "mgr-house-1",
    managerUserId: "mgr-1",
    stage: "In progress",
    bucket: "pending",
  } as DemoApplicantRow;
}

describe("isBookingResidencyRow", () => {
  it("is true only for a row tagged bookingResidency: true", () => {
    expect(isBookingResidencyRow(bookingResidencyRow())).toBe(true);
    expect(isBookingResidencyRow(submittedApplicationRow())).toBe(false);
  });

  it("is not confused with an in-progress draft — different tags, both excluded from their own surfaces", () => {
    const booking = bookingResidencyRow();
    expect(isDraftApplicationRow(booking)).toBe(false); // stage "Booking", not "In progress"
    expect(isBookingResidencyRow(booking)).toBe(true);
  });
});

describe("the count — sidebar nav badge + dashboard 'needs attention' widget", () => {
  it("isSubmittedPendingApplicationRow excludes a booking-residency row", () => {
    expect(isSubmittedPendingApplicationRow(bookingResidencyRow())).toBe(false);
  });

  it("isSubmittedPendingApplicationRow still counts a real submitted application", () => {
    expect(isSubmittedPendingApplicationRow(submittedApplicationRow())).toBe(true);
  });
});

describe("the list — list_applications assistant tool", () => {
  const ctx = makeManagerRowsCtx({
    manager_application_records: [
      managerRow("manager_a", bookingResidencyRow()),
      managerRow("manager_a", submittedApplicationRow()),
    ],
  });

  it("never returns the booking-residency plumbing row", async () => {
    const res = (await listApplicationsTool.handler(ctx, {})) as {
      count: number;
      applications: { id: string; name: string | null }[];
    };
    expect(res.applications.map((a) => a.id)).toEqual(["PROPLANE-REAL1"]);
    expect(res.applications.some((a) => a.name === "Casey Booking")).toBe(false);
  });

  it("stays excluded even when explicitly asked for the pending bucket", async () => {
    const res = (await listApplicationsTool.handler(ctx, { bucket: "pending" })) as {
      applications: { id: string }[];
    };
    expect(res.applications.map((a) => a.id)).toEqual(["PROPLANE-REAL1"]);
  });
});

describe("the reminder sweep — sweepApplicationReminders", () => {
  it("never queues a completion reminder for the booking-residency row", async () => {
    materialize.mockClear();
    const now = new Date("2026-09-20T12:00:00.000Z");
    const record = {
      id: "PROPLANE-BOOK1",
      manager_user_id: "mgr-1",
      resident_email: bookingResidencyRow().email,
      row_data: bookingResidencyRow(),
      created_at: "2026-09-19T12:00:00.000Z",
      updated_at: "2026-09-19T12:00:00.000Z",
    };
    const fakeDb = {
      from: () => ({
        select: () => ({
          order: () => ({ limit: () => Promise.resolve({ data: [record], error: null }) }),
        }),
      }),
    } as never;
    const queued = await sweepApplicationReminders(fakeDb, now);
    expect(queued).toBe(0);
    expect(materialize).not.toHaveBeenCalled();
  });

  it("still queues a completion reminder for a real in-progress draft", async () => {
    materialize.mockClear();
    const now = new Date("2026-09-20T12:00:00.000Z");
    const draft = inProgressDraftRow();
    const record = {
      id: "PROPLANE-DRAFT1",
      manager_user_id: "mgr-1",
      resident_email: draft.email,
      row_data: draft,
      created_at: "2026-09-19T12:00:00.000Z",
      updated_at: "2026-09-19T12:00:00.000Z",
    };
    const fakeDb = {
      from: () => ({
        select: () => ({
          order: () => ({ limit: () => Promise.resolve({ data: [record], error: null }) }),
        }),
      }),
    } as never;
    const queued = await sweepApplicationReminders(fakeDb, now);
    expect(queued).toBeGreaterThan(0);
    expect(materialize).toHaveBeenCalled();
  });
});
