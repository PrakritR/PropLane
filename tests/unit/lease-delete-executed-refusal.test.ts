// @vitest-environment jsdom
/**
 * night/custom-lease item 4: a fully executed lease's document and
 * signatures are legal evidence. `deleteLeasePipelineRow` must refuse rather
 * than silently claim success while `write()`'s immutability guard reverts
 * the mutation underneath it (docs/agents/lease-generation.md's stale "Known
 * gaps" note described this as unguarded — the write-path guard already
 * existed; the caller-facing bug was that it kept returning `true`).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  deleteLeasePipelineRow,
  normalizeLeasePipelineRow,
  readLeasePipeline,
  seedDemoLeasePipeline,
  type LeasePipelineRow,
} from "@/lib/lease-pipeline-storage";

const MANAGER_ID = "manager-delete-refusal";

function signedRow(overrides: Partial<LeasePipelineRow> = {}): LeasePipelineRow {
  return normalizeLeasePipelineRow({
    id: "lease_delete_refusal",
    residentName: "Jordan Lee",
    residentEmail: "jordan.lee@example.com",
    unit: "Unit A",
    bucket: "signed",
    pdfVersion: 2,
    notes: "",
    updatedAtIso: "2026-07-01T00:00:00.000Z",
    managerUserId: MANAGER_ID,
    thread: [],
    generatedHtml: "<html><body>EXECUTED LEASE TEXT</body></html>",
    generatedAtIso: "2026-07-01T00:00:00.000Z",
    status: "Fully Signed",
    residentSignature: { role: "resident", name: "Jordan Lee", signedAtIso: "2026-07-01T00:00:00.000Z" },
    managerSignature: { role: "manager", name: "Pat Manager", signedAtIso: "2026-07-01T01:00:00.000Z" },
    ...overrides,
  });
}

describe("deleteLeasePipelineRow refuses an executed lease", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
    window.localStorage.clear();
    window.history.replaceState({}, "", "/portal/leases");
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));
  });

  it("returns false and keeps the document + signatures for a Fully Signed lease", () => {
    seedDemoLeasePipeline([signedRow()], MANAGER_ID);

    expect(deleteLeasePipelineRow("lease_delete_refusal", MANAGER_ID)).toBe(false);

    const stored = readLeasePipeline(MANAGER_ID).find((r) => r.id === "lease_delete_refusal");
    expect(stored?.generatedHtml).toContain("EXECUTED LEASE TEXT");
    expect(stored?.residentSignature?.name).toBe("Jordan Lee");
    expect(stored?.managerSignature?.name).toBe("Pat Manager");
  });

  it("also refuses a row carrying only the legacy signatureName/signedAtIso shape", () => {
    seedDemoLeasePipeline(
      [signedRow({ residentSignature: null, managerSignature: null, signatureName: "Jordan Lee", signedAtIso: "2026-07-01T00:00:00.000Z" })],
      MANAGER_ID,
    );

    expect(deleteLeasePipelineRow("lease_delete_refusal", MANAGER_ID)).toBe(false);
  });

  it("still allows deleting an unsigned (Manager Review) lease document", () => {
    seedDemoLeasePipeline(
      [
        signedRow({
          bucket: "manager",
          status: "Manager Review",
          residentSignature: null,
          managerSignature: null,
        }),
      ],
      MANAGER_ID,
    );

    expect(deleteLeasePipelineRow("lease_delete_refusal", MANAGER_ID)).toBe(true);
    const stored = readLeasePipeline(MANAGER_ID).find((r) => r.id === "lease_delete_refusal");
    expect(stored?.generatedHtml).toBeNull();
  });
});
