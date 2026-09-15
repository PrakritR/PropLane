import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Anthropic SDK so no test ever makes a network call.
const create = vi.fn();
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));

import {
  extractPdfRentRollText,
  parseRentRollModelPayload,
  readPdfRentRollTable,
} from "@/lib/portfolio-import/pdf-rent-roll.server";
import { PortfolioImportRowLimitError, PortfolioImportUnreadableError } from "@/lib/portfolio-import/errors";
import { PORTFOLIO_IMPORT_MAX_ROWS } from "@/lib/portfolio-import/types";

const FIXTURE_DIR = path.join(process.cwd(), "tests/fixtures/portfolio-import");

function loadFixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(path.join(FIXTURE_DIR, name)));
}

function anthropicTextResponse(body: unknown) {
  return {
    content: [{ type: "text", text: JSON.stringify(body) }],
    usage: { input_tokens: 10, output_tokens: 20 },
    stop_reason: "end_turn",
  };
}

const actor = { userId: "manager_a" };

beforeEach(() => {
  create.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("extractPdfRentRollText", () => {
  it("extracts one page with the expected rent-roll text", async () => {
    const result = await extractPdfRentRollText(loadFixture("rent-roll.pdf"));
    expect(result.pages).toHaveLength(1);
    expect(result.pages[0]).toContain("Maple Court — 220 Maple Ave, Seattle, WA 98103");
    expect(result.pages[0]).toContain("Dana Whitfield");
    expect(result.pages[0]).toContain("1412 Pine St — Seattle, WA 98101");
    expect(result.pages[0]).toContain("Luis Ortega");
    expect(result.characterCount).toBeGreaterThan(40);
  });

  it("throws PortfolioImportUnreadableError for a scanned page with no text", async () => {
    await expect(extractPdfRentRollText(loadFixture("scan-no-text.pdf"))).rejects.toThrow(
      PortfolioImportUnreadableError,
    );
  });
});

describe("parseRentRollModelPayload", () => {
  const headers = ["unitLabel", "residentName", "monthlyRent"];

  it("accepts a well-formed payload", () => {
    const raw = JSON.stringify({
      headers,
      rows: [
        { page: 1, cells: ["1A", "Dana Whitfield", "1850"] },
        { page: 1, cells: ["1B", "Marcus Bell", "1795"] },
      ],
      warnings: ["Skipped a Total row"],
    });
    const result = parseRentRollModelPayload(raw, 1);
    expect(result.headers).toEqual(headers);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toEqual({ page: 1, cells: ["1A", "Dana Whitfield", "1850"] });
    expect(result.warnings).toEqual(["Skipped a Total row"]);
  });

  it("rejects a ragged row whose cell count does not match the headers", () => {
    const raw = JSON.stringify({
      headers,
      rows: [{ page: 1, cells: ["1A", "Dana Whitfield"] }],
      warnings: [],
    });
    expect(() => parseRentRollModelPayload(raw, 1)).toThrow(PortfolioImportUnreadableError);
  });

  it("rejects a row whose page is out of range", () => {
    const raw = JSON.stringify({
      headers,
      rows: [{ page: 5, cells: ["1A", "Dana Whitfield", "1850"] }],
      warnings: [],
    });
    expect(() => parseRentRollModelPayload(raw, 1)).toThrow(PortfolioImportUnreadableError);
  });

  it("enforces the row cap", () => {
    const rows = Array.from({ length: PORTFOLIO_IMPORT_MAX_ROWS + 1 }, () => ({
      page: 1,
      cells: ["1A", "Dana Whitfield", "1850"],
    }));
    const raw = JSON.stringify({ headers, rows, warnings: [] });
    expect(() => parseRentRollModelPayload(raw, 1)).toThrow(PortfolioImportRowLimitError);
  });

  it("rejects an unparsable response", () => {
    expect(() => parseRentRollModelPayload("not json at all", 1)).toThrow(PortfolioImportUnreadableError);
  });
});

describe("readPdfRentRollTable", () => {
  it("throws under the test environment even with an API key set, and never calls the model", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    await expect(
      readPdfRentRollTable({ bytes: loadFixture("rent-roll.pdf"), fileName: "rent-roll.pdf", actor }),
    ).rejects.toThrow(PortfolioImportUnreadableError);
    expect(create).not.toHaveBeenCalled();
  });

  it("throws without an API key even outside the test environment", async () => {
    vi.stubEnv("NODE_ENV", "production");
    await expect(
      readPdfRentRollTable({ bytes: loadFixture("rent-roll.pdf"), fileName: "rent-roll.pdf", actor }),
    ).rejects.toThrow(PortfolioImportUnreadableError);
    expect(create).not.toHaveBeenCalled();
  });

  it("returns a table whose headers are canonical keys and whose rows carry the page, with the sdk stubbed", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    create.mockResolvedValueOnce(
      anthropicTextResponse({
        headers: ["unitLabel", "residentName", "monthlyRent"],
        rows: [
          { page: 1, cells: ["1A", "Dana Whitfield", "1850"] },
          { page: 1, cells: ["1B", "Marcus Bell", "1795"] },
        ],
        warnings: [],
      }),
    );

    const result = await readPdfRentRollTable({
      bytes: loadFixture("rent-roll.pdf"),
      fileName: "rent-roll.pdf",
      actor,
    });

    expect(create).toHaveBeenCalledTimes(1);
    expect(result.aiUsed).toBe(true);
    expect(result.table.headers).toEqual(["unitLabel", "residentName", "monthlyRent"]);
    expect(result.table.rows).toHaveLength(2);
    expect(result.table.rows[0]).toEqual({
      cells: ["1A", "Dana Whitfield", "1850"],
      source: { row: 1, page: 1 },
    });
    expect(result.table.rows[1]).toEqual({
      cells: ["1B", "Marcus Bell", "1795"],
      source: { row: 2, page: 1 },
    });
    // Every returned header is a canonical key, so the deterministic mapper
    // downstream sees every column as a high-confidence exact match.
    expect(result.confidence).toEqual({ 0: "high", 1: "high", 2: "high" });
  });

  it("throws PortfolioImportRowLimitError when the model returns too many rows", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    const rows = Array.from({ length: PORTFOLIO_IMPORT_MAX_ROWS + 1 }, () => ({
      page: 1,
      cells: ["1A"],
    }));
    create.mockResolvedValueOnce(anthropicTextResponse({ headers: ["unitLabel"], rows, warnings: [] }));

    await expect(
      readPdfRentRollTable({ bytes: loadFixture("rent-roll.pdf"), fileName: "rent-roll.pdf", actor }),
    ).rejects.toThrow(PortfolioImportRowLimitError);
  });
});
