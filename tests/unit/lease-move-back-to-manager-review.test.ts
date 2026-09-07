// @vitest-environment jsdom
/**
 * PRP-393 — Move to review must persist. Spreading the computed pipeline view
 * into the upsert was refused as a document replacement (409) after send; the
 * toast still claimed success.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  readLeasePipeline,
  seedDemoLeasePipeline,
  sendLeaseBackToManager,
  type LeasePipelineRow,
} from "@/lib/lease-pipeline-storage";

const MANAGER_ID = "manager-recall-review";
const ROW_ID = "lease_recall_1";
const AXIS_ID = "AXIS-RECALL1";
const STORED_HTML = "<html><body>STORED LEASE BYTES</body></html>";

function leaseRow(overrides: Partial<LeasePipelineRow> = {}): LeasePipelineRow {
  return {
    id: ROW_ID,
    axisId: AXIS_ID,
    residentName: "Diego Morales",
    residentEmail: "diego.morales@example.com",
    unit: "Cascade Lofts · Unit 2A",
    stageLabel: "Resident Signature Pending",
    updated: "Sep 7",
    bucket: "resident",
    pdfVersion: 1,
    notes: "",
    updatedAtIso: "2026-09-07T00:00:00.000Z",
    managerUserId: MANAGER_ID,
    thread: [],
    generatedHtml: STORED_HTML,
    managerUploadedPdf: null,
    status: "Resident Signature Pending",
    sentToResidentAt: "2026-09-07T01:00:00.000Z",
    signedRentLabel: "$1,050.00 / month",
    application: { leaseStart: "2026-09-01", leaseEnd: "2027-08-31" },
    ...overrides,
  };
}

beforeEach(() => {
  window.sessionStorage.clear();
  window.localStorage.clear();
  window.history.replaceState({}, "", "/portal/leases");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      // Fail closed if the client rewrites the document body while recalling.
      if (body.action === "upsert" && body.row) {
        const row = body.row as LeasePipelineRow;
        if (row.generatedHtml !== STORED_HTML) {
          return new Response(
            JSON.stringify({
              error: "This lease is no longer in manager review; its document cannot be replaced.",
            }),
            { status: 409 },
          );
        }
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }),
  );
});

describe("sendLeaseBackToManager (PRP-393)", () => {
  it("persists a stage-only recall without rewriting the document body", async () => {
    seedDemoLeasePipeline([leaseRow()], MANAGER_ID);
    const result = await sendLeaseBackToManager(ROW_ID, MANAGER_ID);
    expect(result).toEqual({ ok: true });
    const row = readLeasePipeline(MANAGER_ID).find((r) => r.id === ROW_ID);
    expect(row?.bucket).toBe("manager");
    expect(row?.status).toBe("Manager Review");
    expect(row?.generatedHtml).toBe(STORED_HTML);
    expect(row?.sentToResidentAt).toBeNull();
    expect(vi.mocked(fetch)).toHaveBeenCalled();
  });

  it("refuses once a signature exists", async () => {
    seedDemoLeasePipeline(
      [
        leaseRow({
          residentSignature: {
            role: "resident",
            name: "Diego Morales",
            signedAtIso: "2026-09-07T02:00:00.000Z",
          },
        }),
      ],
      MANAGER_ID,
    );
    const result = await sendLeaseBackToManager(ROW_ID, MANAGER_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/signature/i);
  });

  it("surfaces a server refusal instead of toasting success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "This lease is no longer in manager review; its document cannot be replaced." }), {
          status: 409,
        }),
      ),
    );
    seedDemoLeasePipeline([leaseRow()], MANAGER_ID);
    const result = await sendLeaseBackToManager(ROW_ID, MANAGER_ID);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no longer in manager review/i);
    const row = readLeasePipeline(MANAGER_ID).find((r) => r.id === ROW_ID);
    expect(row?.bucket).toBe("resident");
  });
});
