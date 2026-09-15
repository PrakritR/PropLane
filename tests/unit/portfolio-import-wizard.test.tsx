// @vitest-environment jsdom
/**
 * The five-step portfolio import wizard: an unreadable upload shows the error
 * panel, a blocking issue disables the commit until excluded, and the invite
 * step's channel chips follow whether this account can text.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PortfolioImportWizard } from "@/components/portal/portfolio-import-wizard";
import type { PortfolioImportDraft, PortfolioImportSummary } from "@/lib/portfolio-import/types";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
}));

vi.mock("@/lib/resident-document-import.client", () => ({
  readDataUrlFromFile: vi.fn(async () => "data:text/csv;base64,Zm9v"),
  parseResidentDocumentPdfClient: vi.fn(async () => ({
    fields: [],
    warnings: [],
    residentMatch: { kind: "new" },
    propertyMatch: {},
    suggestedLeaseBucket: "unsigned",
  })),
}));

vi.mock("@/lib/native/download-or-share", () => ({
  downloadOrShareFile: vi.fn(async () => "downloaded"),
}));

function baseSummary(overrides: Partial<PortfolioImportSummary> = {}): PortfolioImportSummary {
  return {
    importId: "imp1",
    status: "draft",
    fileName: "rent-roll.csv",
    sourceKind: "csv",
    preset: "generic",
    propertyCount: 1,
    unitCount: 1,
    residentCount: 1,
    balanceCount: 0,
    balanceTotal: 0,
    taskCount: 0,
    blockingIssueCount: 0,
    reviewIssueCount: 0,
    invitableByEmail: 1,
    invitableByText: 0,
    createdAt: "2026-09-01T00:00:00.000Z",
    committedAt: null,
    ...overrides,
  };
}

function baseDraft(overrides: Partial<PortfolioImportDraft> = {}): PortfolioImportDraft {
  return {
    version: 1,
    sourceKind: "csv",
    preset: "generic",
    fileName: "rent-roll.csv",
    rowCount: 1,
    columns: [
      { header: "Property", index: 0, key: "propertyName", confidence: "exact", samples: ["Maple Court"] },
      { header: "Resident", index: 1, key: "residentName", confidence: "exact", samples: ["Jordan Lee"] },
    ],
    properties: [
      {
        key: "p1",
        name: "Maple Court",
        address: "120 Maple St",
        beds: 1,
        baths: 1,
        inventoryKind: "unit",
        unitKeys: ["u1"],
        source: { row: 1 },
      },
    ],
    units: [
      {
        key: "u1",
        propertyKey: "p1",
        label: "1A",
        monthlyRent: 1800,
        securityDeposit: 1800,
        occupancy: "occupied",
        residentKeys: ["r1"],
        source: { row: 1 },
      },
    ],
    residents: [
      {
        key: "r1",
        propertyKey: "p1",
        unitKey: "u1",
        name: "Jordan Lee",
        email: null,
        phone: "+15125550100",
        leaseStart: null,
        leaseEnd: null,
        moveIn: null,
        monthlyRent: 1800,
        securityDeposit: 1800,
        balance: null,
        inviteChannels: { email: false, text: true },
        source: { row: 1 },
      },
    ],
    balances: [],
    tasks: [],
    issues: [
      {
        id: "iss1",
        code: "missing_email",
        severity: "block",
        message: "Jordan Lee's email is missing.",
        residentKey: "r1",
      },
    ],
    aiMappedHeaders: false,
    ...overrides,
  };
}

function jsonResponse(status: number, payload: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => payload } as Response;
}

function makeFile(name = "rent-roll.csv"): File {
  return new File(["a,b\n1,2"], name, { type: "text/csv" });
}

describe("PortfolioImportWizard — upload", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the error panel on a 422 unreadable response", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/portal/portfolio-import") {
        return jsonResponse(422, { error: "We couldn't read that file. Try exporting again.", code: "unreadable" });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<PortfolioImportWizard />);
    const input = container.querySelector('[data-attr="portfolio-import-file-input"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [makeFile()] } });

    const panel = await screen.findByRole("alert");
    expect(panel.getAttribute("data-attr")).toBe("portfolio-import-upload-error");
    expect(panel.textContent).toContain("We couldn't read that file");
    expect(panel.textContent).toContain("Try exporting again.");
  });
});

describe("PortfolioImportWizard — review blocking issues", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("disables Import while a block issue is open, and enables it once the row is excluded", async () => {
    let draft = baseDraft();
    let summary = baseSummary({ blockingIssueCount: 1 });

    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/portal/portfolio-import" && init?.method === "POST") {
        return jsonResponse(201, { importId: "imp1", summary, draft });
      }
      if (url === "/api/portal/portfolio-import/imp1" && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body));
        if (body.columns) {
          // Column mapping unchanged — same blocking issue survives.
          return jsonResponse(200, { importId: "imp1", status: "draft", summary, draft });
        }
        if (body.residents?.[0]?.excluded) {
          draft = { ...draft, residents: draft.residents.map((r) => ({ ...r, excluded: true })), issues: [] };
          summary = baseSummary({ blockingIssueCount: 0 });
          return jsonResponse(200, { importId: "imp1", status: "draft", summary, draft });
        }
        return jsonResponse(200, { importId: "imp1", status: "draft", summary, draft });
      }
      throw new Error(`unexpected fetch: ${url} ${init?.method ?? "GET"}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { container } = render(<PortfolioImportWizard />);
    const input = container.querySelector('[data-attr="portfolio-import-file-input"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [makeFile()] } });

    // Step 2: Match columns.
    const continueBtn = await screen.findByRole("button", { name: "Continue" });
    fireEvent.click(continueBtn);

    // Step 3: Review — lands on Issues because of the blocking issue.
    await screen.findByText("Fix to import");
    const importBtn = screen.getByRole("button", { name: /Import 1 property, 1 resident/ });
    expect(importBtn).toBeDisabled();

    const excludeBtn = screen.getByRole("button", { name: "Exclude row" });
    fireEvent.click(excludeBtn);

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /Import 1 property, 1 resident/ })).not.toBeDisabled();
    });
  });
});

describe("PortfolioImportWizard — invite residents", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("shows the messaging setup card and only email chips when the account cannot text", async () => {
    const draft = baseDraft({
      residents: [
        {
          key: "r1",
          propertyKey: "p1",
          unitKey: "u1",
          name: "Jordan Lee",
          email: "jordan@example.com",
          phone: "+15125550100",
          leaseStart: null,
          leaseEnd: null,
          moveIn: null,
          monthlyRent: 1800,
          securityDeposit: 1800,
          balance: null,
          inviteChannels: { email: true, text: true },
          source: { row: 1 },
        },
      ],
      issues: [],
    });
    const summary = baseSummary({ status: "completed", blockingIssueCount: 0 });
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/portal/portfolio-import/imp2") {
        return jsonResponse(200, {
          importId: "imp2",
          status: "completed",
          summary,
          draft,
          messaging: { workNumber: null, canText: false, settingsHref: "/portal/profile?tab=messaging" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<PortfolioImportWizard resumeImportId="imp2" />);

    const setupCard = await screen.findByText("Text invites need a PropLane work number.");
    expect(setupCard).toBeTruthy();
    expect(screen.queryByTitle("Text")).toBeNull();
    expect(screen.getAllByTitle("Email").length).toBeGreaterThan(0);
  });

  it("shows the work number and text chips once the account can text", async () => {
    const draft = baseDraft({
      residents: [
        {
          key: "r1",
          propertyKey: "p1",
          unitKey: "u1",
          name: "Jordan Lee",
          email: "jordan@example.com",
          phone: "+15125550100",
          leaseStart: null,
          leaseEnd: null,
          moveIn: null,
          monthlyRent: 1800,
          securityDeposit: 1800,
          balance: null,
          inviteChannels: { email: true, text: true },
          source: { row: 1 },
        },
      ],
      issues: [],
    });
    const summary = baseSummary({ status: "completed", blockingIssueCount: 0 });
    const fetchMock = vi.fn(async (url: string) => {
      if (url === "/api/portal/portfolio-import/imp3") {
        return jsonResponse(200, {
          importId: "imp3",
          status: "completed",
          summary,
          draft,
          messaging: { workNumber: "+15125550199", canText: true, settingsHref: "/portal/profile?tab=messaging" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<PortfolioImportWizard resumeImportId="imp3" />);

    const ready = await screen.findByText(/Texts go from/);
    expect(ready.textContent).toContain("+15125550199");
    expect(screen.getAllByTitle("Text").length).toBeGreaterThan(0);
  });
});
