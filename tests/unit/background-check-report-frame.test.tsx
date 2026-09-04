// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import type { DemoApplicantRow } from "@/data/demo-portal";

vi.mock("@/lib/demo/demo-session", async (importOriginal) => ({
  // Spread the real module: this file only needs to override demo mode,
  // and a hand-listed mock silently breaks every time the module gains an
  // export a component calls at import time.
  ...(await importOriginal<typeof import("@/lib/demo/demo-session")>()),
  isDemoModeActive: () => false,
}));
vi.mock("@/lib/screening/screening-test-mode", () => ({
  isScreeningTestModeActive: () => false,
}));

import { BackgroundCheckReportFrame } from "@/components/portal/application-screening-panel";

afterEach(cleanup);

function completeRow(): DemoApplicantRow {
  return {
    id: "PROPLANE-TEST",
    name: "Olivia Brooks",
    email: "olivia.brooks.workflow@test.proplane.local",
    property: "Ballard House",
    propertyId: "prop-ballard",
    stage: "Submitted",
    bucket: "approved",
    detail: "Approved",
    application: {
      consentCredit: true,
      email: "olivia.brooks.workflow@test.proplane.local",
    } as DemoApplicantRow["application"],
    backgroundCheck: {
      provider: "checkr",
      candidateId: "cand-1",
      reportId: "order-1",
      reportResourceId: "rp_test_abc",
      packageSlug: "essential",
      status: "complete",
      result: "clear",
      orderedAt: "2026-07-31T00:00:00.000Z",
      completedAt: "2026-07-31T00:05:00.000Z",
      reportSnapshot: {
        credit_score: 720,
        criminal: { status: "clear" },
      },
    },
  };
}

describe("BackgroundCheckReportFrame", () => {
  it("loads the official Checkr PDF for a completed check", async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(pdfBytes, { status: 200, headers: { "Content-Type": "application/pdf" } }),
    );

    const { container } = render(<BackgroundCheckReportFrame row={completeRow()} demo={false} />);

    await waitFor(() => {
      const iframe = container.querySelector("iframe");
      expect(iframe?.getAttribute("src")).toContain("/api/screening/background-check/document");
      expect(iframe?.getAttribute("src")).toContain("applicationId=PROPLANE-TEST");
    });

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/screening/background-check/document"),
      expect.objectContaining({ credentials: "include" }),
    );

    fetchMock.mockRestore();
  });

  it("falls back to inline HTML when the PDF proxy fails", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ error: "Could not retrieve the Checkr report PDF." }), {
        status: 502,
        headers: { "Content-Type": "application/json" },
      }),
    );

    const { container } = render(<BackgroundCheckReportFrame row={completeRow()} demo={false} />);

    await waitFor(() => {
      const iframe = container.querySelector("iframe");
      expect(iframe?.getAttribute("srcdoc") ?? "").toContain("Olivia Brooks");
    });

    fetchMock.mockRestore();
  });
});
