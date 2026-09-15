/**
 * POST /api/portal/property-import/read — manager-only, multipart, refuses
 * bad files by code, and hands back what the model understood. The read
 * itself is mocked; the reader runs for real on tiny csv bodies.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { getReportsAuthContext, rateLimit, track, understandPropertyImport, FakeUnderstandError } = vi.hoisted(() => {
  class FakeUnderstandError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = "PropertyImportUnderstandError";
      this.code = code;
    }
  }
  return {
    getReportsAuthContext: vi.fn(),
    rateLimit: vi.fn(),
    track: vi.fn(),
    understandPropertyImport: vi.fn(),
    FakeUnderstandError,
  };
});

vi.mock("@/lib/reports/auth", () => ({ getReportsAuthContext }));
vi.mock("@/lib/rate-limit", () => ({ rateLimit }));
vi.mock("@/lib/analytics/posthog", () => ({ track }));
vi.mock("@/lib/property-import/understand.server", () => ({
  understandPropertyImport,
  PropertyImportUnderstandError: FakeUnderstandError,
}));

import { POST } from "@/app/api/portal/property-import/read/route";

const MANAGER = { role: "manager" as const, userId: "mgr-1", email: "m@test.proplane.local", db: {} as never };

function upload(name: string, body: string | Uint8Array, type = "text/csv", hint?: string) {
  const form = new FormData();
  form.set("file", new File([body], name, { type }));
  if (hint) form.set("hint", hint);
  return new Request("http://localhost/api/portal/property-import/read", { method: "POST", body: form });
}

beforeEach(() => {
  vi.clearAllMocks();
  getReportsAuthContext.mockResolvedValue(MANAGER);
  rateLimit.mockResolvedValue({ ok: true });
  understandPropertyImport.mockResolvedValue({
    fileName: "roll.csv",
    sourceKind: "csv",
    sheets: [{ name: "Sheet1", whatItIs: "One row per unit", used: true }],
    properties: [{ key: "1-x", name: "400 Pike St", address: "400 Pike St", rooms: [], sourceRows: [2], needsLook: [] }],
    summary: ["One property."],
    truncatedNote: null,
    rowsRead: 2,
  });
});

describe("POST /api/portal/property-import/read", () => {
  it("401s signed out and 404s a resident", async () => {
    getReportsAuthContext.mockResolvedValueOnce(null);
    expect((await POST(upload("roll.csv", "Address,Rent\n400 Pike St,1200"))).status).toBe(401);
    getReportsAuthContext.mockResolvedValueOnce({ ...MANAGER, role: "resident" });
    expect((await POST(upload("roll.csv", "Address,Rent\n400 Pike St,1200"))).status).toBe(404);
    expect(understandPropertyImport).not.toHaveBeenCalled();
  });

  it("reads a csv and returns the understanding, tracking the read without the file name", async () => {
    const res = await POST(upload("roll.csv", "Address,Rent\n400 Pike St,1200"));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.understanding.properties).toHaveLength(1);
    const call = understandPropertyImport.mock.calls[0]![0];
    expect(call.source.rowsRead).toBe(2);
    expect(call.hint).toBeNull();
    expect(call.actor).toEqual({ userId: "mgr-1", metadata: { landlordId: "mgr-1" } });
    expect(track).toHaveBeenCalledWith("property_import_read", "mgr-1", expect.objectContaining({ propertyCount: 1, withHint: false }));
    expect(JSON.stringify(track.mock.calls[0])).not.toContain("roll.csv");
  });

  it("passes the manager's hint through and tracks it as a re-read", async () => {
    const res = await POST(upload("roll.csv", "Address,Rent\n400 Pike St,1200", "text/csv", "each tab is one house"));
    expect(res.status).toBe(200);
    expect(understandPropertyImport.mock.calls[0]![0].hint).toBe("each tab is one house");
    expect(track).toHaveBeenCalledWith("property_import_reread", "mgr-1", expect.objectContaining({ withHint: true }));
  });

  it("refuses by code: unsupported type 415, empty 422, oversize 413, missing file 400", async () => {
    expect((await POST(upload("photo.png", new Uint8Array([1, 2, 3]), "image/png"))).status).toBe(415);
    expect((await POST(upload("x.csv", ""))).status).toBe(422);
    expect((await POST(upload("big.csv", new Uint8Array(5 * 1024 * 1024 + 1)))).status).toBe(413);
    const form = new FormData();
    form.set("hint", "no file");
    expect((await POST(new Request("http://localhost/x", { method: "POST", body: form }))).status).toBe(400);
    expect(understandPropertyImport).not.toHaveBeenCalled();
  });

  it("maps a model refusal to its code and never throws", async () => {
    understandPropertyImport.mockRejectedValueOnce(new FakeUnderstandError("unreadable", "PropLane couldn't make sense of that file."));
    const res = await POST(upload("roll.csv", "Address,Rent\n400 Pike St,1200"));
    expect(res.status).toBe(422);
    expect(await res.json()).toEqual({ ok: false, error: "PropLane couldn't make sense of that file.", code: "unreadable" });
    understandPropertyImport.mockRejectedValueOnce(new Error("boom"));
    expect((await POST(upload("roll.csv", "Address,Rent\n400 Pike St,1200"))).status).toBe(422);
  });

  it("rate limits", async () => {
    rateLimit.mockResolvedValueOnce({ ok: false });
    expect((await POST(upload("roll.csv", "Address,Rent\n400 Pike St,1200"))).status).toBe(429);
  });
});
