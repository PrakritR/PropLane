/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyAddPersonForm } from "@/components/portal/resident-wizard/state";
import type { DemoApplicantRow } from "@/data/demo-portal";

vi.mock("@/lib/manager-applications-storage");
vi.mock("@/lib/household-charges");
vi.mock("@/lib/lease-pipeline-storage");
vi.mock("@/lib/uploaded-lease-parse.client");
vi.mock("@/components/marketing/application-photo-field", () => ({ uploadApplicationPhoto: vi.fn() }));
vi.mock("@/lib/manual-planned-tour.client", () => ({ createManualPlannedTourClient: vi.fn() }));
vi.mock("@/lib/portal-message-delivery", () => ({ deliverPortalInboxMessage: vi.fn() }));
import { upsertApplicationRowToServerAwait } from "@/lib/manager-applications-storage";
import { ensureManagerReviewLeaseForApplication, sendLeaseToResident } from "@/lib/lease-pipeline-storage";
import { uploadAndParseLeasePdf, confirmUploadedLeaseOnCreate } from "@/lib/uploaded-lease-parse.client";
import { commitResident } from "@/components/portal/resident-wizard/commit";

const row = { id: "PROPLANE-QA", name: "QA Resident", email: "qa@example.invalid", managerUserId: "staff", bucket: "approved", stage: "Active", detail: "", property: "QA House", manuallyAdded: true } as DemoApplicantRow;
const ctx = { userId: "staff", executedLeaseKeys: { axisIds: new Set<string>(), emails: new Set<string>() }, propertyLabelFor: () => "QA House", assignee: null };

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(upsertApplicationRowToServerAwait).mockResolvedValue({ ok: true, row: { ...row, managerUserId: "owner" } });
  vi.mocked(ensureManagerReviewLeaseForApplication).mockReturnValue({ ok: true, row: { id: "lease-qa" } } as ReturnType<typeof ensureManagerReviewLeaseForApplication>);
  vi.mocked(uploadAndParseLeasePdf).mockResolvedValue({ ok: true });
  vi.mocked(confirmUploadedLeaseOnCreate).mockResolvedValue({ ok: true });
  vi.mocked(sendLeaseToResident).mockResolvedValue({ ok: true });
});

describe("resident lease filing reports partial failures", () => {
  it.each(["reading", "confirmation"])("keeps the resident but refuses sending after a %s save failure", async (failure) => {
    if (failure === "reading") vi.mocked(uploadAndParseLeasePdf).mockResolvedValue({ ok: true, saveError: "Reading did not save" });
    else vi.mocked(confirmUploadedLeaseOnCreate).mockResolvedValue({ ok: false, error: "Confirmation did not save" });
    const form = { ...emptyAddPersonForm("resident"), leaseDocument: "draft" as const, leaseFile: new File(["%PDF"], "qa.pdf", { type: "application/pdf" }) };
    const result = await commitResident(row, form, ctx, { sendLease: true });
    expect(result.ok).toBe(false);
    expect(result.row.managerUserId).toBe("owner");
    expect(result.failures.row).toBeUndefined();
    expect(result.failures.lease).toMatch(/did not save/);
    expect(sendLeaseToResident).not.toHaveBeenCalled();
    if (failure === "reading") expect(confirmUploadedLeaseOnCreate).not.toHaveBeenCalled();
  });

  it("does not generate or send when lease creation is deferred", async () => {
    const form = { ...emptyAddPersonForm("resident"), alsoCreate: [] };
    const result = await commitResident(row, form, ctx);
    expect(result.ok).toBe(true);
    expect(result.row.managerUserId).toBe("owner");
    expect(ensureManagerReviewLeaseForApplication).not.toHaveBeenCalled();
    expect(sendLeaseToResident).not.toHaveBeenCalled();
  });
});
