// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LeasePipelineRow } from "@/lib/lease-pipeline-storage";

const downloadTextContent = vi.fn(async () => "downloaded" as const);
const downloadDataUrl = vi.fn(async () => "downloaded" as const);

vi.mock("@/lib/portal-document-download", () => ({
  downloadTextContent: (...args: unknown[]) => downloadTextContent(...args),
  downloadDataUrl: (...args: unknown[]) => downloadDataUrl(...args),
  leaseDownloadBaseName: () => "jane_doe",
  portalDownloadToastMessage: () => null,
}));

vi.mock("@/lib/lease-pipeline-storage", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/lease-pipeline-storage")>();
  return { ...actual };
});

describe("downloadLeaseFromRow", () => {
  beforeEach(() => {
    downloadTextContent.mockClear();
    downloadDataUrl.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("downloads manager-uploaded PDF via data URL helper", async () => {
    const { downloadLeaseFromRow } = await import("@/lib/lease-pipeline-storage");
    const row = {
      id: "lease-1",
      residentName: "Jane Doe",
      residentEmail: "jane@example.com",
      managerUploadedPdf: { dataUrl: "data:application/pdf;base64,abc", fileName: "lease.pdf" },
      generatedHtml: "<html>ignored when pdf present</html>",
    } as LeasePipelineRow;

    await expect(downloadLeaseFromRow(row)).resolves.toBe("downloaded");
    expect(downloadDataUrl).toHaveBeenCalledWith("data:application/pdf;base64,abc", "lease.pdf");
    expect(downloadTextContent).not.toHaveBeenCalled();
  });

  it("downloads generated HTML when no uploaded PDF exists", async () => {
    const { downloadLeaseFromRow, getLeaseDocumentHtml } = await import("@/lib/lease-pipeline-storage");
    const row = {
      id: "lease-2",
      residentName: "Jane Doe",
      residentEmail: "jane@example.com",
      generatedHtml: "<html><body>Lease body</body></html>",
    } as LeasePipelineRow;

    const html = getLeaseDocumentHtml(row);
    expect(html).toContain("Lease body");

    await expect(downloadLeaseFromRow(row)).resolves.toBe("downloaded");
    expect(downloadTextContent).toHaveBeenCalledWith(
      html,
      "PropLane-Lease-jane_doe.html",
      "text/html;charset=utf-8",
      "Lease",
    );
  });

  it("loads omitted list-row bytes before download", () => {
    const src = readFileSync(join(process.cwd(), "src/lib/lease-pipeline-storage.ts"), "utf8");
    expect(src).toContain("ensureLeaseDocumentLoaded(row.id, undefined, row)");
  });
});
