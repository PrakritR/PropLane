// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  inProgressApplicationResumeUrl,
  buildInProgressApplicationRow,
  applicationStageDisplayLabel,
  findInProgressRowForTarget,
  INCOMPLETE_APPLICATION_LABEL,
  isInProgressApplicationRow,
  isSubmittedPendingApplicationRow,
  shouldOfferApplicationCompletionReminder,
  switchApplicationTargetProperty,
  syncInProgressApplicationRow,
  IN_PROGRESS_APPLICATION_STAGE,
} from "@/lib/rental-application/in-progress-application";
import { clearRentalWizardDraft, loadRentalWizardDraftAxisId, saveRentalWizardDraftAxisId } from "@/lib/rental-application/drafts";
import { isWithdrawnApplicationRow, sortResidentApplicationRows } from "@/lib/rental-application/resident-application-list";
import { residentApplicationSubmitBlocked } from "@/lib/rental-application/application-policy";
import { createInitialRentalWizardState } from "@/lib/rental-application/state";

vi.mock("@/lib/manager-applications-storage", async () => {
  // The downgrade rule itself is the thing under test — keep the real one.
  const actual = await vi.importActual<typeof import("@/lib/manager-applications-storage")>(
    "@/lib/manager-applications-storage",
  );
  return {
    MANAGER_APPLICATIONS_EVENT: "axis:manager-applications",
    wouldDowngradeSubmittedApplication: actual.wouldDowngradeSubmittedApplication,
    isBookingResidencyRow: actual.isBookingResidencyRow,
    readManagerApplicationRows: vi.fn(() => []),
    replaceManagerApplicationRowInCache: vi.fn(),
    upsertApplicationRowToServer: vi.fn(),
  };
});

vi.mock("@/lib/rental-application/data", () => ({
  getPropertyById: vi.fn((id: string) => ({
    id,
    title: "Test Property",
    managerUserId: "mgr-1",
    listingSubmission: {
      v: 1,
      allowMultiplePropertyApplications: id === "prop-multi",
    },
  })),
}));

import {
  readManagerApplicationRows,
  replaceManagerApplicationRowInCache,
  upsertApplicationRowToServer,
} from "@/lib/manager-applications-storage";

describe("in-progress-application", () => {
  it("detects in-progress pending rows", () => {
    expect(
      isInProgressApplicationRow({
        id: "AXIS-1",
        name: "A",
        property: "P",
        bucket: "pending",
        stage: IN_PROGRESS_APPLICATION_STAGE,
        detail: "",
      }),
    ).toBe(true);
    expect(
      isInProgressApplicationRow({
        id: "AXIS-LEGACY",
        name: "A",
        property: "P",
        bucket: "pending",
        stage: INCOMPLETE_APPLICATION_LABEL,
        detail: "",
      }),
    ).toBe(true);
    expect(
      isInProgressApplicationRow({
        id: "AXIS-2",
        name: "A",
        property: "P",
        bucket: "pending",
        stage: "Submitted",
        detail: "",
      }),
    ).toBe(false);
  });

  it("offers completion reminder for legacy Incomplete stage storage", () => {
    expect(
      shouldOfferApplicationCompletionReminder({
        id: "AXIS-LEGACY",
        name: "A",
        property: "P",
        bucket: "pending",
        stage: INCOMPLETE_APPLICATION_LABEL,
        detail: "",
      }),
    ).toBe(true);
  });

  it("offers completion reminder for wizard snapshot rows without stage metadata", () => {
    expect(
      shouldOfferApplicationCompletionReminder({
        id: "PROPLANE-SNAPSHOT",
        name: "Applicant",
        property: "Ballard House",
        bucket: "pending",
        stage: "",
        detail: "",
        email: "resident@test.proplane.local",
        application: {
          propertyId: "prop-ballard",
          email: "resident@test.proplane.local",
          fullLegalName: "Applicant",
        } as never,
      }),
    ).toBe(true);
    expect(
      isInProgressApplicationRow({
        id: "PROPLANE-SNAPSHOT",
        name: "Applicant",
        property: "Ballard House",
        bucket: "pending",
        stage: "",
        detail: "",
        application: { propertyId: "prop-ballard" } as never,
      }),
    ).toBe(true);
  });

  it("offers completion reminder for pending rows with only top-level property metadata", () => {
    expect(
      shouldOfferApplicationCompletionReminder({
        id: "PROPLANE-E2E86A70",
        name: "Applicant",
        property: "Ballard House",
        propertyId: "prop-ballard",
        bucket: "pending",
        stage: "",
        detail: "",
        email: "resident@test.proplane.local",
      }),
    ).toBe(true);
  });

  it("offers completion reminder on incomplete detail even when stage metadata is ambiguous", () => {
    expect(
      shouldOfferApplicationCompletionReminder(
        {
          id: "PROPLANE-E2E86A70",
          name: "A",
          property: "P",
          bucket: "pending",
          stage: "",
          detail: "",
        },
        { viewingIncompleteApplicationDetail: true },
      ),
    ).toBe(true);
    expect(
      shouldOfferApplicationCompletionReminder(
        {
          id: "PROPLANE-SUBMITTED",
          name: "A",
          property: "P",
          bucket: "pending",
          stage: "Submitted",
          detail: "",
        },
        { viewingIncompleteApplicationDetail: true },
      ),
    ).toBe(false);
  });

  it("detects submitted pending rows separately from in-progress", () => {
    const inProgress = {
      id: "AXIS-1",
      name: "A",
      property: "P",
      bucket: "pending" as const,
      stage: IN_PROGRESS_APPLICATION_STAGE,
      detail: "",
    };
    const submitted = { ...inProgress, id: "AXIS-2", stage: "Submitted" };
    expect(isSubmittedPendingApplicationRow(inProgress)).toBe(false);
    expect(isSubmittedPendingApplicationRow(submitted)).toBe(true);
  });

  it("excludes a resident-withdrawn row so it never inflates the actionable pending count", () => {
    // A withdrawn application keeps bucket=pending, but the resident pulled out —
    // it is not awaiting review, so it must stay off the nav badge / dashboard count.
    const submitted = {
      id: "AXIS-3",
      name: "A",
      property: "P",
      bucket: "pending" as const,
      stage: "Submitted",
      detail: "",
    };
    const withdrawn = { ...submitted, id: "AXIS-4", withdrawnAt: "2026-07-22T00:00:00.000Z" };
    expect(isSubmittedPendingApplicationRow(submitted)).toBe(true);
    expect(isSubmittedPendingApplicationRow(withdrawn)).toBe(false);
  });

  it("maps in-progress storage stage to Incomplete in the UI", () => {
    const form = { ...createInitialRentalWizardState(), propertyId: "prop-1" };
    const row = buildInProgressApplicationRow({
      axisId: "PROPLANE-ABC",
      form,
      residentEmail: "jane@test.com",
    });
    expect(row.stage).toBe(IN_PROGRESS_APPLICATION_STAGE);
    expect(applicationStageDisplayLabel(row)).toBe(INCOMPLETE_APPLICATION_LABEL);
  });

  it("uses public apply resume url", () => {
    const form = { ...createInitialRentalWizardState(), propertyId: "prop-1", fullLegalName: "Jane Doe" };
    const row = buildInProgressApplicationRow({
      axisId: "AXIS-ABC",
      form,
      residentEmail: "jane@test.com",
    });
    expect(inProgressApplicationResumeUrl("https://axis.test", row)).toBe(
      "https://axis.test/rent/apply?propertyId=prop-1",
    );
    expect(
      inProgressApplicationResumeUrl("https://axis.test", row, {
        token: "resume-token",
        axisId: "PROPLANE-57B6CC11",
      }),
    ).toBe(
      "https://axis.test/rent/apply?propertyId=prop-1&token=resume-token&proplane_id=PROPLANE-57B6CC11",
    );
  });

  it("builds a pending in-progress row from wizard form", () => {
    const form = { ...createInitialRentalWizardState(), propertyId: "prop-1", fullLegalName: "Jane Doe" };
    const row = buildInProgressApplicationRow({
      axisId: "AXIS-ABC",
      form,
      residentEmail: "jane@test.com",
    });
    expect(row.stage).toBe(IN_PROGRESS_APPLICATION_STAGE);
    expect(row.bucket).toBe("pending");
    expect(row.propertyId).toBe("prop-1");
    expect(row.email).toBe("jane@test.com");
  });

  it("withdrawal is final: reapplying to the same property never resumes the withdrawn draft", () => {
    // Withdraw the resident's ONLY application, then reapply to the same
    // property. The withdrawn draft must not be resumed — the apply comparator
    // returns nothing for it, so the wizard starts a brand-new application.
    const withdrawnDraft = buildInProgressApplicationRow({
      axisId: "PROPLANE-WD1",
      form: { ...createInitialRentalWizardState(), propertyId: "prop-1", roomChoice1: "prop-1::room-1" },
      residentEmail: "jane@test.com",
    });
    withdrawnDraft.withdrawnAt = "2026-07-27T00:00:00.000Z";

    // Reapply to the exact same property/room the withdrawn draft was for.
    expect(
      findInProgressRowForTarget([withdrawnDraft], { propertyId: "prop-1", listingRoomId: "room-1" }),
    ).toBeUndefined();
    // A bare reapply (no room) to that property also finds nothing to resume.
    expect(findInProgressRowForTarget([withdrawnDraft], { propertyId: "prop-1" })).toBeUndefined();

    // A live (non-withdrawn) draft for the same target IS still resumed — the
    // exclusion is scoped to withdrawal, not a regression of normal resume.
    const liveDraft = { ...withdrawnDraft, id: "PROPLANE-LIVE1", withdrawnAt: undefined };
    expect(findInProgressRowForTarget([liveDraft], { propertyId: "prop-1" })?.id).toBe("PROPLANE-LIVE1");
  });

  it("switchApplicationTargetProperty resumes or mints a fresh axis id per property", () => {
    clearRentalWizardDraft();

    const row = buildInProgressApplicationRow({
      axisId: "PROPLANE-PROP2",
      form: { ...createInitialRentalWizardState(), propertyId: "prop-2", fullLegalName: "Jamie" },
      residentEmail: "jamie@test.com",
    });
    saveRentalWizardDraftAxisId("PROPLANE-PROP1");

    const resumed = switchApplicationTargetProperty({
      previousPropertyId: "prop-1",
      nextPropertyId: "prop-2",
      inProgressRows: [row],
    });
    expect(resumed?.axisId).toBe("PROPLANE-PROP2");
    expect(loadRentalWizardDraftAxisId()).toBe("PROPLANE-PROP2");

    clearRentalWizardDraft();
    saveRentalWizardDraftAxisId("PROPLANE-PROP1");
    const fresh = switchApplicationTargetProperty({
      previousPropertyId: "prop-1",
      nextPropertyId: "prop-3",
      inProgressRows: [row],
    });
    expect(fresh?.axisId).toMatch(/^PROPLANE-/);
    expect(fresh?.axisId).not.toBe("PROPLANE-PROP1");
    expect(loadRentalWizardDraftAxisId()).toBe(fresh?.axisId);
  });

  it("withdrawal removes the row from the resident's active list but the manager keeps the record", () => {
    const withdrawn = buildInProgressApplicationRow({
      axisId: "PROPLANE-WD2",
      form: { ...createInitialRentalWizardState(), propertyId: "prop-1" },
      residentEmail: "jane@test.com",
    });
    withdrawn.withdrawnAt = "2026-07-27T00:00:00.000Z";
    const allRows = [withdrawn];

    // Manager view keeps the withdrawn record (final for the applicant ≠ deleted).
    expect(allRows.some((r) => r.id === "PROPLANE-WD2")).toBe(true);
    expect(isWithdrawnApplicationRow(withdrawn)).toBe(true);

    // Resident active list (the panel's filter) excludes it, leaving a clean
    // empty state — the apply entry point stays regardless (rendered separately).
    const activeList = sortResidentApplicationRows(allRows.filter((r) => !isWithdrawnApplicationRow(r)));
    expect(activeList).toHaveLength(0);
  });
});

describe("syncInProgressApplicationRow never downgrades a submitted application", () => {
  const AXIS_ID = "PROPLANE-DRAFT001";
  const form = { ...createInitialRentalWizardState(), propertyId: "prop-1", fullLegalName: "Jane Doe" };

  beforeEach(() => {
    vi.mocked(replaceManagerApplicationRowInCache).mockClear();
    vi.mocked(upsertApplicationRowToServer).mockClear();
    vi.mocked(readManagerApplicationRows).mockReturnValue([]);
  });

  it("drops a trailing draft sync once the row is submitted", () => {
    vi.mocked(readManagerApplicationRows).mockReturnValue([
      {
        id: AXIS_ID,
        name: "Jane Doe",
        property: "P",
        propertyId: "prop-1",
        bucket: "pending",
        stage: "Submitted",
        detail: "",
        email: "jane@test.com",
      },
    ]);

    syncInProgressApplicationRow({ axisId: AXIS_ID, form, residentEmail: "jane@test.com" });

    expect(replaceManagerApplicationRowInCache).not.toHaveBeenCalled();
    expect(upsertApplicationRowToServer).not.toHaveBeenCalled();
  });

  it("still writes a draft that has not been submitted yet", () => {
    vi.mocked(readManagerApplicationRows).mockReturnValue([
      {
        id: AXIS_ID,
        name: "Jane",
        property: "P",
        propertyId: "prop-1",
        bucket: "pending",
        stage: IN_PROGRESS_APPLICATION_STAGE,
        detail: "",
        email: "jane@test.com",
      },
    ]);

    syncInProgressApplicationRow({ axisId: AXIS_ID, form, residentEmail: "jane@test.com" });

    expect(upsertApplicationRowToServer).toHaveBeenCalledTimes(1);
    expect(vi.mocked(upsertApplicationRowToServer).mock.calls[0][0].stage).toBe(IN_PROGRESS_APPLICATION_STAGE);
  });

  it("still writes the first draft when no row exists yet", () => {
    syncInProgressApplicationRow({ axisId: AXIS_ID, form, residentEmail: "jane@test.com" });
    expect(upsertApplicationRowToServer).toHaveBeenCalledTimes(1);
  });

  // Regression: the downgrade guard tested the EXISTING row with the exact
  // `isDraftApplicationRow` (stage must be literally "In progress"). A legacy or
  // blank-stage draft failed that test, so it read as already-submitted and every
  // autosave after it was dropped as a submitted -> draft downgrade — the draft
  // silently stopped saving, with no error and no toast. The existing side now
  // uses the wider `isDraftShapedApplicationRow`.
  it("keeps autosaving a legacy draft whose stage metadata is blank", () => {
    vi.mocked(readManagerApplicationRows).mockReturnValue([
      {
        id: AXIS_ID,
        name: "Jane",
        property: "P",
        propertyId: "prop-1",
        bucket: "pending",
        // Older rows were persisted with no stage at all.
        stage: "",
        detail: "",
        email: "jane@test.com",
      },
    ]);

    syncInProgressApplicationRow({ axisId: AXIS_ID, form, residentEmail: "jane@test.com" });

    expect(replaceManagerApplicationRowInCache).toHaveBeenCalledTimes(1);
    expect(upsertApplicationRowToServer).toHaveBeenCalledTimes(1);
    expect(vi.mocked(upsertApplicationRowToServer).mock.calls[0][0].stage).toBe(IN_PROGRESS_APPLICATION_STAGE);
  });

  it.each(["draft", "started", INCOMPLETE_APPLICATION_LABEL])(
    "keeps autosaving a legacy draft stored with stage %s",
    (stage) => {
      vi.mocked(readManagerApplicationRows).mockReturnValue([
        {
          id: AXIS_ID,
          name: "Jane",
          property: "P",
          propertyId: "prop-1",
          bucket: "pending",
          stage,
          detail: "",
          email: "jane@test.com",
        },
      ]);

      syncInProgressApplicationRow({ axisId: AXIS_ID, form, residentEmail: "jane@test.com" });

      expect(upsertApplicationRowToServer).toHaveBeenCalledTimes(1);
    },
  );

  it("keeps autosaving a stage-less wizard snapshot carrying only application data", () => {
    vi.mocked(readManagerApplicationRows).mockReturnValue([
      {
        id: AXIS_ID,
        name: "Jane",
        property: "",
        bucket: "pending",
        stage: "",
        detail: "",
        email: "jane@test.com",
        application: { propertyId: "prop-1", email: "jane@test.com" },
      } as never,
    ]);

    syncInProgressApplicationRow({ axisId: AXIS_ID, form, residentEmail: "jane@test.com" });

    expect(upsertApplicationRowToServer).toHaveBeenCalledTimes(1);
  });

  // The widened EXISTING side must not weaken the guard this function exists for:
  // a genuinely submitted row is still rejected by the wider predicate, so a
  // racing draft write is still dropped. Covers "Submitted" in any casing.
  it.each(["Submitted", "submitted", "  SUBMITTED  "])(
    "still drops a racing draft sync against a submitted row (stage %s)",
    (stage) => {
      vi.mocked(readManagerApplicationRows).mockReturnValue([
        {
          id: AXIS_ID,
          name: "Jane Doe",
          property: "P",
          propertyId: "prop-1",
          bucket: "pending",
          stage,
          detail: "",
          email: "jane@test.com",
        },
      ]);

      syncInProgressApplicationRow({ axisId: AXIS_ID, form, residentEmail: "jane@test.com" });

      expect(replaceManagerApplicationRowInCache).not.toHaveBeenCalled();
      expect(upsertApplicationRowToServer).not.toHaveBeenCalled();
    },
  );
});

describe("application-policy in-progress", () => {
  beforeEach(() => {
    vi.mocked(readManagerApplicationRows).mockReturnValue([]);
  });

  it("allows finishing an in-progress application on the same property", () => {
    vi.mocked(readManagerApplicationRows).mockReturnValue([
      {
        id: "AXIS-DRAFT",
        email: "a@test.com",
        bucket: "pending",
        name: "A",
        property: "P",
        propertyId: "prop-single",
        stage: IN_PROGRESS_APPLICATION_STAGE,
        detail: "",
      },
    ]);
    const block = residentApplicationSubmitBlocked({
      propertyId: "prop-single",
      residentEmail: "a@test.com",
    });
    expect(block.blocked).toBe(false);
  });

  it("blocks duplicate submitted pending applications", () => {
    vi.mocked(readManagerApplicationRows).mockReturnValue([
      {
        id: "AXIS-1",
        email: "a@test.com",
        bucket: "pending",
        name: "A",
        property: "P",
        propertyId: "prop-multi",
        stage: "Submitted",
        detail: "",
        application: { roomChoice1: "room-a" } as never,
      },
    ]);
    const block = residentApplicationSubmitBlocked({
      propertyId: "prop-multi",
      residentEmail: "a@test.com",
      roomChoice1: "room-a",
    });
    expect(block.blocked).toBe(true);
  });
});
