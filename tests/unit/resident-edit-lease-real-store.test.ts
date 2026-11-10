// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { seedDemoManagerApplicationRows } from "@/lib/manager-applications-storage";
import { persistLeaseRowToServerAwait, readLeasePipeline, readStoredLeasePipelineForResidentEdit, regenerateEditableLeasesForResident, seedDemoLeasePipeline, type LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import { residentEditLeaseIds } from "@/lib/resident-edit-lease-scope";

vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()), isDemoModeActive: () => false }));
vi.mock("@/lib/manager-portfolio-access", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/manager-portfolio-access")>()), leaseVisibleToPortalUser: () => true }));
vi.mock("@/lib/generated-lease", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/generated-lease")>()),
  buildAiGeneratedLeaseHtml: () => ({ kind: "generated", html: "<p>Generated fixture</p>", executedJurisdiction: "WA", templateVersion: "fixture" }),
}));

const owner = "manager-1";
const oldApp = { id: "AXIS-TARGET", managerUserId: owner, propertyId: "old-house", email: "r@example.invalid", bucket: "approved", application: { propertyId: "old-house", roomChoice1: "old-house::room", fullLegalName: "Resident", leaseStart: "2026-11-01", leaseEnd: "2027-10-31", leaseTerm: "12 months", rentalType: "standard" } } as DemoApplicantRow;
const updated = { ...oldApp, propertyId: "new-house", application: { ...oldApp.application!, propertyId: "new-house", roomChoice1: "new-house::room" } };
function lease(id: string, overrides: Partial<LeasePipelineRow> = {}): LeasePipelineRow {
  return { id, axisId: oldApp.id, managerUserId: owner, propertyId: "old-house", residentName: "Resident", residentEmail: oldApp.email, unit: "Old", stageLabel: "Draft", updated: "", bucket: "manager", pdfVersion: 1, notes: "", updatedAtIso: "2026-01-01T00:00:00Z", thread: [], status: "Draft", application: oldApp.application, ...overrides } as LeasePipelineRow;
}
beforeEach(() => { sessionStorage.clear(); localStorage.clear(); vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 }))); });
it("selects stored identity before enrichment and keeps signed and uploaded same-email rows untouched", async () => {
  seedDemoManagerApplicationRows([updated], owner);
  const rows = [lease("target"), lease("signed", { axisId: "AXIS-OTHER", status: "Fully Signed", generatedHtml: "signed bytes" }), lease("uploaded", { axisId: "AXIS-OTHER2", managerUploadedPdf: { fileName: "x.pdf", dataUrl: "data:application/pdf;base64,AA==" } as LeasePipelineRow["managerUploadedPdf"] })];
  seedDemoLeasePipeline(rows, owner);
  const raw = readStoredLeasePipelineForResidentEdit(owner);
  expect(raw.find((row) => row.id === "target")?.propertyId).toBe("old-house");
  const scope = residentEditLeaseIds(raw, updated, oldApp);
  expect(scope.ids).toEqual(["target"]);
  const before = readLeasePipeline(owner);
  expect(regenerateEditableLeasesForResident(updated.email, owner, updated.application, { persist: false, leaseIds: scope.ids })).toBe(1);
  const persistedTarget = readStoredLeasePipelineForResidentEdit(owner).find((row) => row.id === "target");
  expect(persistedTarget).toMatchObject({ propertyId: "new-house", roomChoice: "new-house::room" });
  expect(persistedTarget?.generatedHtml).toBeTruthy();
  const after = readLeasePipeline(owner);
  expect(after.find((row) => row.id === "signed")).toEqual(before.find((row) => row.id === "signed"));
  expect(after.find((row) => row.id === "uploaded")).toEqual(before.find((row) => row.id === "uploaded"));
  const leaseWrites = () => vi.mocked(fetch).mock.calls.filter(([url, init]) => String(url).includes("/api/portal-lease-pipeline") && init?.method === "POST");
  expect(leaseWrites()).toHaveLength(0);
  expect((await persistLeaseRowToServerAwait(persistedTarget!)).ok).toBe(true);
  const sent = JSON.parse(String(leaseWrites()[0]![1]?.body));
  expect(sent.row).toMatchObject({ id: "target", propertyId: "new-house", roomChoice: "new-house::room" });
  expect(leaseWrites()).toHaveLength(1);
});

it("does not select a stored wrong-owner lease even when application enrichment makes it appear owned", () => {
  seedDemoManagerApplicationRows([updated], owner);
  seedDemoLeasePipeline([lease("wrong-owner", { managerUserId: "other" })], owner);
  const raw = readStoredLeasePipelineForResidentEdit(owner);
  expect(raw[0]?.managerUserId).toBe("other");
  expect(readLeasePipeline(owner)[0]?.managerUserId).toBe(owner);
  expect(residentEditLeaseIds(raw, updated, oldApp).ids).toEqual([]);
});
