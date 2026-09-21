/**
 * Portfolio import routes — auth, caps, and the PATCH merge, following the
 * same mocking shape as property-import-route.test.ts. The model reads and
 * the store are mocked; only routing/validation/wiring is under test here.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  getReportsAuthContext,
  rateLimit,
  track,
  readPropertyImportFile,
  understandPropertyImport,
  understandResidents,
  createPortfolioImportProposal,
  loadImportProposal,
  updateImportProposal,
  applyAnswersAndSkips,
  createPortfolioImportRecords,
  FakePropertyImportFileError,
  FakePortfolioImportNotFoundError,
} = vi.hoisted(() => {
  class FakePropertyImportFileError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = "PropertyImportFileError";
      this.code = code;
    }
  }
  class FakePortfolioImportNotFoundError extends Error {
    constructor() {
      super("No import with that id belongs to this manager.");
      this.name = "PortfolioImportNotFoundError";
    }
  }
  return {
    getReportsAuthContext: vi.fn(),
    rateLimit: vi.fn(),
    track: vi.fn(),
    readPropertyImportFile: vi.fn(),
    understandPropertyImport: vi.fn(),
    understandResidents: vi.fn(),
    createPortfolioImportProposal: vi.fn(),
    loadImportProposal: vi.fn(),
    updateImportProposal: vi.fn(),
    applyAnswersAndSkips: vi.fn(),
    createPortfolioImportRecords: vi.fn(),
    FakePropertyImportFileError,
    FakePortfolioImportNotFoundError,
  };
});

vi.mock("@/lib/reports/auth", () => ({ getReportsAuthContext }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit }));
vi.mock("@/lib/analytics/posthog", () => ({ track }));
vi.mock("@/lib/property-import/read-file.server", () => ({ readPropertyImportFile, PropertyImportFileError: FakePropertyImportFileError }));
vi.mock("@/lib/property-import/understand.server", () => ({
  understandPropertyImport,
  PropertyImportUnderstandError: class extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));
vi.mock("@/lib/portfolio-import/understand-residents.server", () => ({
  understandResidents,
  UnderstandResidentsError: class extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
    }
  },
}));
vi.mock("@/lib/portfolio-import/store.server", () => ({
  createPortfolioImportProposal,
  loadImportProposal,
  updateImportProposal,
  applyAnswersAndSkips,
}));
vi.mock("@/lib/portfolio-import/create.server", () => ({
  createPortfolioImportRecords,
  PortfolioImportNotFoundError: FakePortfolioImportNotFoundError,
}));

import { POST as postUpload } from "@/app/api/portal/portfolio-import/route";
import { GET as getImport, PATCH as patchImport } from "@/app/api/portal/portfolio-import/[importId]/route";
import { POST as postCreate } from "@/app/api/portal/portfolio-import/[importId]/create/route";

const MANAGER = { role: "manager" as const, userId: "mgr-1", email: "m@test.proplane.local", db: {} as never };

function upload(files: { name: string; body: string | Uint8Array; type?: string }[], hint?: string) {
  const form = new FormData();
  for (const f of files) form.append("files", new File([f.body], f.name, { type: f.type ?? "text/csv" }));
  if (hint) form.set("hint", hint);
  return new Request("http://localhost/api/portal/portfolio-import", { method: "POST", body: form });
}

const PROPOSAL = {
  importId: "imp-1",
  files: [{ name: "roll.csv", kind: "spreadsheet" as const }],
  properties: [],
  summary: { properties: 0, rooms: 0, residents: 0, charges: 0, tasks: 0, gaps: 0 },
};

beforeEach(() => {
  vi.clearAllMocks();
  getReportsAuthContext.mockResolvedValue(MANAGER);
  rateLimit.mockResolvedValue({ ok: true });
  readPropertyImportFile.mockResolvedValue({ kind: "csv", fileName: "roll.csv", sheets: [], pages: [], rowsRead: 2, truncatedNote: null });
  understandPropertyImport.mockResolvedValue({ fileName: "roll.csv", sourceKind: "csv", sheets: [], properties: [], summary: [], truncatedNote: null, rowsRead: 2 });
  understandResidents.mockResolvedValue([]);
  createPortfolioImportProposal.mockResolvedValue(undefined);
});

describe("POST /api/portal/portfolio-import", () => {
  it("401s signed out and 404s a resident", async () => {
    getReportsAuthContext.mockResolvedValueOnce(null);
    expect((await postUpload(upload([{ name: "roll.csv", body: "a,b\n1,2" }]))).status).toBe(401);
    getReportsAuthContext.mockResolvedValueOnce({ ...MANAGER, role: "resident" });
    expect((await postUpload(upload([{ name: "roll.csv", body: "a,b\n1,2" }]))).status).toBe(404);
    expect(understandPropertyImport).not.toHaveBeenCalled();
  });

  it("rate limits before touching any file", async () => {
    rateLimit.mockResolvedValueOnce({ ok: false });
    expect((await postUpload(upload([{ name: "roll.csv", body: "a,b\n1,2" }]))).status).toBe(429);
    expect(readPropertyImportFile).not.toHaveBeenCalled();
  });

  it("requires at least one file and caps at 50", async () => {
    const empty = new Request("http://localhost/x", { method: "POST", body: new FormData() });
    expect((await postUpload(empty)).status).toBe(400);

    const form = new FormData();
    for (let i = 0; i < 51; i += 1) form.append("files", new File(["a,b\n1,2"], `f${i}.csv`, { type: "text/csv" }));
    expect((await postUpload(new Request("http://localhost/x", { method: "POST", body: form }))).status).toBe(400);
    expect(readPropertyImportFile).not.toHaveBeenCalled();
  });

  it("413s a file over 5MB without reading any file", async () => {
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    expect((await postUpload(upload([{ name: "big.csv", body: big }]))).status).toBe(413);
    expect(readPropertyImportFile).not.toHaveBeenCalled();
  });

  it("reads every file, proposes, stores, and tracks the read", async () => {
    understandPropertyImport.mockResolvedValueOnce({
      fileName: "roll.csv",
      sourceKind: "csv",
      sheets: [],
      properties: [{ key: "1-x", name: "400 Pike St", address: "400 Pike St", city: "", state: "", zip: "", propertyType: "house", rentByRoom: false, bedrooms: 1, bathrooms: null, monthlyRent: 1200, deposit: null, rooms: [], sourceSheet: "Sheet1", sourceRows: [2], needsLook: [], confidence: "high" }],
      summary: [],
      truncatedNote: null,
      rowsRead: 2,
    });
    const res = await postUpload(upload([{ name: "roll.csv", body: "a,b\n1,2" }]));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.proposal.properties).toHaveLength(1);
    expect(createPortfolioImportProposal).toHaveBeenCalledTimes(1);
    expect(track).toHaveBeenCalledWith("portfolio_import_read", "mgr-1", expect.objectContaining({ files: 1 }));
  });

  it("maps a file read failure to its code and stops before understanding", async () => {
    readPropertyImportFile.mockRejectedValueOnce(new FakePropertyImportFileError("too_large", "over 5mb"));
    const res = await postUpload(upload([{ name: "roll.csv", body: "a,b\n1,2" }]));
    expect(res.status).toBe(413);
    expect(understandPropertyImport).not.toHaveBeenCalled();
  });
});

describe("GET/PATCH /api/portal/portfolio-import/[importId]", () => {
  const params = Promise.resolve({ importId: "imp-1" });

  it("GET 401s signed out, 404s missing, 200s a found proposal", async () => {
    getReportsAuthContext.mockResolvedValueOnce(null);
    expect((await getImport(new Request("http://localhost/x"), { params })).status).toBe(401);

    loadImportProposal.mockResolvedValueOnce(null);
    expect((await getImport(new Request("http://localhost/x"), { params })).status).toBe(404);

    loadImportProposal.mockResolvedValueOnce({ row: { status: "draft" }, proposal: PROPOSAL });
    const res = await getImport(new Request("http://localhost/x"), { params });
    expect(res.status).toBe(200);
    expect((await res.json()).proposal.importId).toBe("imp-1");
  });

  it("PATCH merges answers/skips through applyAnswersAndSkips and persists the result", async () => {
    loadImportProposal.mockResolvedValue({ row: { status: "draft" }, proposal: PROPOSAL });
    const merged = { ...PROPOSAL, summary: { ...PROPOSAL.summary, gaps: 0 } };
    applyAnswersAndSkips.mockReturnValue(merged);

    const body = { answers: { "p1:resident:0": { email: "new@example.com" } }, skips: ["p1:room:1"] };
    const res = await patchImport(new Request("http://localhost/x", { method: "PATCH", body: JSON.stringify(body) }), { params });
    expect(res.status).toBe(200);
    expect(applyAnswersAndSkips).toHaveBeenCalledWith(PROPOSAL, body);
    expect(updateImportProposal).toHaveBeenCalledWith(MANAGER.db, "mgr-1", "imp-1", merged);
    expect((await res.json()).proposal).toEqual(merged);
  });

  it("PATCH rejects a malformed body", async () => {
    const res = await patchImport(new Request("http://localhost/x", { method: "PATCH", body: JSON.stringify({ answers: "nope" }) }), { params });
    expect(res.status).toBe(400);
    expect(applyAnswersAndSkips).not.toHaveBeenCalled();
  });
});

describe("POST /api/portal/portfolio-import/[importId]/create", () => {
  const params = Promise.resolve({ importId: "imp-1" });

  it("401s signed out, 404s a resident", async () => {
    getReportsAuthContext.mockResolvedValueOnce(null);
    expect((await postCreate(new Request("http://localhost/x", { method: "POST", body: "{}" }), { params })).status).toBe(401);
    getReportsAuthContext.mockResolvedValueOnce({ ...MANAGER, role: "resident" });
    expect((await postCreate(new Request("http://localhost/x", { method: "POST", body: "{}" }), { params })).status).toBe(404);
  });

  it("defaults sendInvites to false and passes the manager's answers/skips through", async () => {
    createPortfolioImportRecords.mockResolvedValueOnce({ created: { properties: 1, rooms: 1, residents: 1, leases: 1, charges: 1, tasks: 1, invites: 0 }, failures: [] });
    const res = await postCreate(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({}) }), { params });
    expect(res.status).toBe(200);
    expect(createPortfolioImportRecords).toHaveBeenCalledWith(MANAGER.db, { userId: "mgr-1", email: "m@test.proplane.local", managerName: "m@test.proplane.local" }, "imp-1", { sendInvites: false, answers: undefined, skips: undefined });
  });

  it("404s a not-found import", async () => {
    createPortfolioImportRecords.mockRejectedValueOnce(new FakePortfolioImportNotFoundError());
    const res = await postCreate(new Request("http://localhost/x", { method: "POST", body: "{}" }), { params });
    expect(res.status).toBe(404);
  });

  it("tracks the create outcome", async () => {
    createPortfolioImportRecords.mockResolvedValueOnce({ created: { properties: 2, rooms: 3, residents: 2, leases: 2, charges: 4, tasks: 6, invites: 2 }, failures: [{ propertyKey: "p2", address: "x", message: "boom" }] });
    await postCreate(new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ sendInvites: true }) }), { params });
    expect(track).toHaveBeenCalledWith("portfolio_import_created", "mgr-1", expect.objectContaining({ properties: 2, failures: 1, sendInvites: true }));
  });
});
