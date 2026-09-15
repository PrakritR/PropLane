import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest } from "../helpers/api-request";

const {
  getReportsAuthContext,
  rateLimit,
  parsePortfolioImportUpload,
  createPortfolioImport,
  listPortfolioImports,
  loadPortfolioImport,
  summaryFor,
  sha256Hex,
  commitPortfolioImport,
  draftHasBlockingIssues,
  track,
  FakePortfolioImportDuplicateError,
  FakePortfolioImportUnreadableError,
  FakePortfolioImportRowLimitError,
  FakePortfolioImportBlockedError,
} = vi.hoisted(() => {
  class DuplicateError extends Error {
    importId: string;
    constructor(importId: string) {
      super("An import for this exact file is already in progress.");
      this.name = "PortfolioImportDuplicateError";
      this.importId = importId;
    }
  }
  class UnreadableError extends Error {
    constructor(message = "We couldn't read that file.") {
      super(message);
      this.name = "PortfolioImportUnreadableError";
    }
  }
  class RowLimitError extends Error {
    count: number;
    constructor(count: number) {
      super("Too many rows.");
      this.name = "PortfolioImportRowLimitError";
      this.count = count;
    }
  }
  class BlockedError extends Error {
    constructor(message = "This import has issues that need to be resolved before it can be committed.") {
      super(message);
      this.name = "PortfolioImportBlockedError";
    }
  }
  return {
    getReportsAuthContext: vi.fn(),
    rateLimit: vi.fn(),
    parsePortfolioImportUpload: vi.fn(),
    createPortfolioImport: vi.fn(),
    listPortfolioImports: vi.fn(),
    loadPortfolioImport: vi.fn(),
    summaryFor: vi.fn(),
    sha256Hex: vi.fn(() => "a".repeat(64)),
    commitPortfolioImport: vi.fn(),
    draftHasBlockingIssues: vi.fn(),
    track: vi.fn(),
    FakePortfolioImportDuplicateError: DuplicateError,
    FakePortfolioImportUnreadableError: UnreadableError,
    FakePortfolioImportRowLimitError: RowLimitError,
    FakePortfolioImportBlockedError: BlockedError,
  };
});

vi.mock("@/lib/reports/auth", () => ({ getReportsAuthContext }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit }));
vi.mock("@/lib/analytics/posthog", () => ({ track }));
vi.mock("@/lib/portfolio-import/parse.server", () => ({
  parsePortfolioImportUpload,
  loadManagerExistingResidentEmails: vi.fn(async () => []),
}));
vi.mock("@/lib/portfolio-import/errors", () => ({
  PortfolioImportUnreadableError: FakePortfolioImportUnreadableError,
  PortfolioImportRowLimitError: FakePortfolioImportRowLimitError,
}));
vi.mock("@/lib/portfolio-import/store.server", () => ({
  createPortfolioImport,
  listPortfolioImports,
  loadPortfolioImport,
  updatePortfolioImportDraft: vi.fn(),
  discardPortfolioImport: vi.fn(),
  loadReceipts: vi.fn(async () => []),
  summaryFor,
  sha256Hex,
  PortfolioImportDuplicateError: FakePortfolioImportDuplicateError,
}));
vi.mock("@/lib/portfolio-import/commit.server", () => ({
  commitPortfolioImport,
  PortfolioImportBlockedError: FakePortfolioImportBlockedError,
}));
vi.mock("@/lib/portfolio-import/build-draft", () => ({
  draftHasBlockingIssues,
  buildPortfolioImportDraft: vi.fn(),
  recomputeDraftAfterEdits: vi.fn(),
}));
vi.mock("@/lib/portfolio-import/invite.server", () => ({
  portfolioImportMessagingStatus: vi.fn(async () => ({ workNumber: null, canText: false, settingsHref: "/portal/profile?tab=messaging" })),
}));

import { POST as uploadPost, GET as listGet } from "@/app/api/portal/portfolio-import/route";
import { GET as importGet } from "@/app/api/portal/portfolio-import/[importId]/route";
import { POST as commitPost } from "@/app/api/portal/portfolio-import/[importId]/commit/route";

const MANAGER_AUTH = { role: "manager" as const, userId: "mgr-1", email: "m@test.proplane.local", db: {} as never };

function smallCsvDataUrl(): string {
  const csv = "Property,Unit,Tenant,Email,Rent\nThe Pioneer,1A,Alice,alice@test.proplane.local,1000\n";
  return `data:text/csv;base64,${Buffer.from(csv).toString("base64")}`;
}

describe("POST /api/portal/portfolio-import", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rateLimit.mockResolvedValue({ ok: true });
    summaryFor.mockReturnValue({ importId: "import-1", status: "draft" });
  });

  it("401s when signed out", async () => {
    getReportsAuthContext.mockResolvedValue(null);
    const res = await uploadPost(
      jsonRequest("http://localhost/api/portal/portfolio-import", { method: "POST", body: { dataUrl: smallCsvDataUrl(), fileName: "roster.csv" } }),
    );
    expect(res.status).toBe(401);
  });

  it("404s for a non-manager role", async () => {
    getReportsAuthContext.mockResolvedValue({ role: "resident", userId: "u1", email: "u1@test.proplane.local", db: {} });
    const res = await uploadPost(
      jsonRequest("http://localhost/api/portal/portfolio-import", { method: "POST", body: { dataUrl: smallCsvDataUrl(), fileName: "roster.csv" } }),
    );
    expect(res.status).toBe(404);
  });

  it("413s when the data URL is too large", async () => {
    getReportsAuthContext.mockResolvedValue(MANAGER_AUTH);
    const huge = `data:text/csv;base64,${"A".repeat(6 * 1024 * 1024)}`;
    const res = await uploadPost(
      jsonRequest("http://localhost/api/portal/portfolio-import", { method: "POST", body: { dataUrl: huge, fileName: "roster.csv" } }),
    );
    expect(res.status).toBe(413);
  });

  it("429s when rate limited", async () => {
    getReportsAuthContext.mockResolvedValue(MANAGER_AUTH);
    rateLimit.mockResolvedValue({ ok: false });
    const res = await uploadPost(
      jsonRequest("http://localhost/api/portal/portfolio-import", { method: "POST", body: { dataUrl: smallCsvDataUrl(), fileName: "roster.csv" } }),
    );
    expect(res.status).toBe(429);
  });

  it("409s with the existing import id when the same file was already uploaded", async () => {
    getReportsAuthContext.mockResolvedValue(MANAGER_AUTH);
    parsePortfolioImportUpload.mockResolvedValue({
      sourceKind: "csv",
      preset: "generic",
      table: { headers: [], rows: [{ cells: [], source: { row: 1 } }], skippedRows: [] },
      draft: { rowCount: 1, properties: [{}], residents: [] },
      aiMappedHeaders: false,
    });
    createPortfolioImport.mockRejectedValue(new FakePortfolioImportDuplicateError("import-existing"));

    const res = await uploadPost(
      jsonRequest("http://localhost/api/portal/portfolio-import", { method: "POST", body: { dataUrl: smallCsvDataUrl(), fileName: "roster.csv" } }),
    );
    expect(res.status).toBe(409);
    const data = (await res.json()) as { importId?: string };
    expect(data.importId).toBe("import-existing");
  });

  it("422s with code unreadable when the file can't be parsed", async () => {
    getReportsAuthContext.mockResolvedValue(MANAGER_AUTH);
    parsePortfolioImportUpload.mockRejectedValue(new FakePortfolioImportUnreadableError("Couldn't read that file."));

    const res = await uploadPost(
      jsonRequest("http://localhost/api/portal/portfolio-import", { method: "POST", body: { dataUrl: smallCsvDataUrl(), fileName: "roster.csv" } }),
    );
    expect(res.status).toBe(422);
    const data = (await res.json()) as { code?: string };
    expect(data.code).toBe("unreadable");
  });

  it("lists this manager's imports on GET", async () => {
    getReportsAuthContext.mockResolvedValue(MANAGER_AUTH);
    listPortfolioImports.mockResolvedValue([{ id: "import-1" }]);
    summaryFor.mockReturnValue({ importId: "import-1", status: "draft" });

    const res = await listGet();
    expect(res.status).toBe(200);
    const data = (await res.json()) as { imports: unknown[] };
    expect(data.imports).toHaveLength(1);
  });
});

describe("GET /api/portal/portfolio-import/[importId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("404s for an import owned by another manager", async () => {
    getReportsAuthContext.mockResolvedValue(MANAGER_AUTH);
    loadPortfolioImport.mockResolvedValue(null);

    const res = await importGet(new Request("http://localhost/api/portal/portfolio-import/import-1"), {
      params: Promise.resolve({ importId: "import-1" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/portal/portfolio-import/[importId]/commit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rateLimit.mockResolvedValue({ ok: true });
  });

  it("409s with blocking_issues when the draft still has unresolved block issues", async () => {
    getReportsAuthContext.mockResolvedValue(MANAGER_AUTH);
    loadPortfolioImport.mockResolvedValue({
      id: "import-1",
      status: "draft",
      draft: {
        table: { headers: [], rows: [], skippedRows: [] },
        draft: { issues: [{ id: "missing_email:x", code: "missing_email", severity: "block", message: "No email.", resolved: false }] },
      },
      result: null,
    });
    draftHasBlockingIssues.mockReturnValue(true);

    const res = await commitPost(new Request("http://localhost/api/portal/portfolio-import/import-1/commit", { method: "POST" }), {
      params: Promise.resolve({ importId: "import-1" }),
    });
    expect(res.status).toBe(409);
    const data = (await res.json()) as { error?: string; count?: number };
    expect(data.error).toBe("blocking_issues");
    expect(data.count).toBe(1);
    expect(commitPortfolioImport).not.toHaveBeenCalled();
  });

  it("returns the stored result with 200 when the import is already completed", async () => {
    getReportsAuthContext.mockResolvedValue(MANAGER_AUTH);
    loadPortfolioImport.mockResolvedValue({
      id: "import-1",
      status: "completed",
      draft: { table: { headers: [], rows: [], skippedRows: [] }, draft: { issues: [] } },
      result: { status: "completed", progress: [], propertyIds: ["imp-1"], residentApplicationIds: [], taskIds: [], balanceChargeIds: [], failures: [] },
    });

    const res = await commitPost(new Request("http://localhost/api/portal/portfolio-import/import-1/commit", { method: "POST" }), {
      params: Promise.resolve({ importId: "import-1" }),
    });
    expect(res.status).toBe(200);
    expect(commitPortfolioImport).not.toHaveBeenCalled();
  });
});
