/**
 * The client-side rent-roll attachment path
 * (src/lib/assistant-chat-attachments.client.ts): a csv/xlsx file, or a pdf
 * whose name looks like a rent roll, is detected as an import candidate and
 * routed to `createPortfolioImport` instead of becoming file bytes on the
 * chat payload. `createPortfolioImport`/`getPortfolioImport` are mocked so
 * this exercises only the attachment classification/shaping logic.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const createPortfolioImportMock = vi.fn();
const getPortfolioImportMock = vi.fn();

vi.mock("@/lib/portfolio-import.client", () => ({
  createPortfolioImport: (...args: unknown[]) => createPortfolioImportMock(...args),
  getPortfolioImport: (...args: unknown[]) => getPortfolioImportMock(...args),
}));

const {
  isPortfolioImportCandidateFile,
  createReadingImportAttachment,
  resolvePortfolioImportAttachment,
  attachmentsToApiPayload,
  userMessageContentFromInput,
  CHAT_ATTACHMENT_ACCEPT,
} = await import("@/lib/assistant-chat-attachments.client");

beforeEach(() => {
  vi.clearAllMocks();
});

function csvFile(name = "maple-court-rent-roll.csv"): File {
  return new File(["header\nrow"], name, { type: "text/csv" });
}

describe("CHAT_ATTACHMENT_ACCEPT", () => {
  it("accepts csv and xlsx alongside images and pdf", () => {
    expect(CHAT_ATTACHMENT_ACCEPT).toContain(".csv");
    expect(CHAT_ATTACHMENT_ACCEPT).toContain(".xlsx");
    expect(CHAT_ATTACHMENT_ACCEPT).toContain("application/pdf");
  });
});

describe("isPortfolioImportCandidateFile", () => {
  it("is true for a .csv file", () => {
    expect(isPortfolioImportCandidateFile(csvFile())).toBe(true);
  });

  it("is true for a .xlsx file by extension even with a generic media type", () => {
    const file = new File(["x"], "buildium-export.xlsx", { type: "application/octet-stream" });
    expect(isPortfolioImportCandidateFile(file)).toBe(true);
  });

  it("is true for a pdf whose name looks like a rent roll", () => {
    const file = new File(["%PDF"], "2024-rent-roll.pdf", { type: "application/pdf" });
    expect(isPortfolioImportCandidateFile(file)).toBe(true);
  });

  it("is false for an unrelated pdf, so a lease attachment stays a plain document", () => {
    const file = new File(["%PDF"], "signed-lease.pdf", { type: "application/pdf" });
    expect(isPortfolioImportCandidateFile(file)).toBe(false);
  });

  it("is false for an image", () => {
    const file = new File(["x"], "photo.jpg", { type: "image/jpeg" });
    expect(isPortfolioImportCandidateFile(file)).toBe(false);
  });
});

describe("createReadingImportAttachment", () => {
  it("returns an immediate placeholder in the reading state", () => {
    const att = createReadingImportAttachment(csvFile("rent-roll.csv"));
    expect(att.kind).toBe("import");
    expect(att.status).toBe("reading");
    expect(att.importId).toBeNull();
    expect(att.summaryLine).toBeNull();
    expect(att.fileName).toBe("rent-roll.csv");
  });
});

describe("resolvePortfolioImportAttachment", () => {
  it("becomes ready with a summary line on success", async () => {
    createPortfolioImportMock.mockResolvedValue({
      ok: true,
      importId: "import-1",
      summary: { propertyCount: 2, unitCount: 7, residentCount: 6 },
      draft: {},
    });

    const result = await resolvePortfolioImportAttachment("att-1", csvFile());
    expect(result.id).toBe("att-1");
    expect(result.status).toBe("ready");
    expect(result.importId).toBe("import-1");
    expect(result.summaryLine).toContain("2 properties");
    expect(result.summaryLine).toContain("7 units");
    expect(result.summaryLine).toContain("6 residents");
  });

  it("reuses the existing draft on a 409 duplicate instead of failing", async () => {
    createPortfolioImportMock.mockResolvedValue({
      ok: false,
      status: 409,
      error: "This file was already imported.",
      importId: "existing-import",
    });
    getPortfolioImportMock.mockResolvedValue({
      ok: true,
      importId: "existing-import",
      status: "draft",
      summary: { propertyCount: 2, unitCount: 7, residentCount: 6 },
      draft: {},
    });

    const result = await resolvePortfolioImportAttachment("att-2", csvFile());
    expect(result.status).toBe("ready");
    expect(result.importId).toBe("existing-import");
    expect(result.summaryLine).toContain("Already imported");
  });

  it("becomes an error state on a non-409 failure and never sets an importId", async () => {
    createPortfolioImportMock.mockResolvedValue({
      ok: false,
      status: 422,
      error: "This file has no data rows to import.",
    });

    const result = await resolvePortfolioImportAttachment("att-3", csvFile());
    expect(result.status).toBe("error");
    expect(result.importId).toBeNull();
    expect(result.error).toBe("This file has no data rows to import.");
  });
});

describe("attachmentsToApiPayload", () => {
  it("only carries importIds for ready import attachments, never a reading or failed one", () => {
    const payload = attachmentsToApiPayload([
      { id: "a", kind: "import", fileName: "ready.csv", status: "ready", importId: "import-ready", summaryLine: "1 property · 1 unit · 1 resident" },
      { id: "b", kind: "import", fileName: "still-reading.csv", status: "reading", importId: null, summaryLine: null },
      { id: "c", kind: "import", fileName: "failed.csv", status: "error", importId: null, summaryLine: null, error: "bad file" },
      { id: "d", kind: "image", fileName: "photo.jpg", mediaType: "image/jpeg", dataBase64: "AAAA" },
    ]);
    expect(payload.importIds).toEqual(["import-ready"]);
    expect(payload.images).toEqual([{ mediaType: "image/jpeg", dataBase64: "AAAA" }]);
  });
});

describe("userMessageContentFromInput", () => {
  it("names an import attachment as an attached rent roll when the text is empty", () => {
    const text = userMessageContentFromInput("", [
      { id: "a", kind: "import", fileName: "maple-court.csv", status: "ready", importId: "import-1", summaryLine: "…" },
    ]);
    expect(text).toBe("[attached rent roll: maple-court.csv]");
  });

  it("still prefers typed text over any attachment fallback", () => {
    const text = userMessageContentFromInput("  Please import this  ", [
      { id: "a", kind: "import", fileName: "maple-court.csv", status: "ready", importId: "import-1", summaryLine: "…" },
    ]);
    expect(text).toBe("Please import this");
  });
});
