import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest, parseJsonResponse } from "../helpers/api-request";

/**
 * `/api/vendor/documents/signed-url` — the vendor's OWN compliance documents
 * (a different store from `/api/vendor/shared-documents/[id]/signed-url`,
 * which mints for manager-shared `manager_documents` rows) now only ever
 * reach bytes through a server-minted, short-lived signed URL
 * (docs/agents/documents-module.md), mirroring that existing route instead of
 * the old `/api/vendor/documents/file` direct stream.
 */

const mocks = vi.hoisted(() => ({
  resolveVendorPortalUserId: vi.fn(),
  createSupabaseServiceRoleClient: vi.fn(),
  resolveOwnVendorRecords: vi.fn(),
}));

vi.mock("@/lib/auth/vendor-api-access", () => ({
  resolveVendorPortalUserId: mocks.resolveVendorPortalUserId,
}));

vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: mocks.createSupabaseServiceRoleClient,
}));

vi.mock("@/lib/vendor-own-record", () => ({
  resolveOwnVendorRecords: mocks.resolveOwnVendorRecords,
}));

import { GET } from "@/app/api/vendor/documents/signed-url/route";
import { VENDOR_DOCUMENTS_BUCKET } from "@/lib/vendor-documents-storage";

const VENDOR_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function mockStorage(signed: { path: string; ttl: number; opts: unknown }[]) {
  return {
    from: (bucket: string) => ({
      createSignedUrl: async (path: string, ttl: number, opts?: unknown) => {
        if (bucket !== VENDOR_DOCUMENTS_BUCKET) {
          return { data: null, error: { message: `unexpected bucket ${bucket}` } };
        }
        signed.push({ path, ttl, opts });
        return { data: { signedUrl: `https://storage.example/${path}?sig=mock` }, error: null };
      },
    }),
  };
}

function ownRecordWithDoc(storagePath: string, fileName = "cert.pdf") {
  return [
    {
      id: "mv-1",
      managerUserId: "mgr-1",
      row: {
        id: "mv-1",
        managerUserId: "mgr-1",
        vendorDocuments: [
          {
            kind: "insurance",
            fileName,
            storagePath,
            url: "/api/vendor/documents/signed-url?kind=insurance",
            uploadedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    },
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveVendorPortalUserId.mockResolvedValue({ ok: true, userId: VENDOR_ID });
});

describe("vendor documents signed-url route", () => {
  it("401s an unauthenticated caller without ever loading a record or signing anything", async () => {
    mocks.resolveVendorPortalUserId.mockResolvedValue({ ok: false, status: 401 });
    const res = await GET(jsonRequest("http://t/api/vendor/documents/signed-url?kind=insurance"));
    const { status, data } = await parseJsonResponse<{ error?: string }>(res);

    expect(status).toBe(401);
    expect(data.error).toMatch(/unauthorized/i);
    expect(mocks.resolveOwnVendorRecords).not.toHaveBeenCalled();
  });

  it("400s an invalid kind", async () => {
    mocks.createSupabaseServiceRoleClient.mockReturnValue({ storage: mockStorage([]) });
    const res = await GET(jsonRequest("http://t/api/vendor/documents/signed-url?kind=not-a-real-kind"));
    expect(res.status).toBe(400);
  });

  it("mints a short-lived signed URL for the caller's own document", async () => {
    const storagePath = `vendor-documents/${VENDOR_ID}/insurance-1.pdf`;
    mocks.resolveOwnVendorRecords.mockResolvedValue(ownRecordWithDoc(storagePath));
    const signed: { path: string; ttl: number; opts: unknown }[] = [];
    mocks.createSupabaseServiceRoleClient.mockReturnValue({ storage: mockStorage(signed) });

    const res = await GET(jsonRequest("http://t/api/vendor/documents/signed-url?kind=insurance"));
    const { status, data } = await parseJsonResponse<{ url?: string; fileName?: string; mimeType?: string }>(res);

    expect(status).toBe(200);
    expect(data.url).toBe(`https://storage.example/${storagePath}?sig=mock`);
    expect(data.fileName).toBe("cert.pdf");
    expect(data.mimeType).toBe("application/pdf");
    expect(signed).toEqual([{ path: storagePath, ttl: 300, opts: undefined }]);
    expect(signed[0]!.ttl).toBeLessThanOrEqual(600); // short-lived, never a durable link
  });

  it("passes a download filename option only when ?download=1 is set — never an inline disposition through this route", async () => {
    const storagePath = `vendor-documents/${VENDOR_ID}/insurance-1.pdf`;
    mocks.resolveOwnVendorRecords.mockResolvedValue(ownRecordWithDoc(storagePath, "cert.pdf"));
    const signed: { path: string; ttl: number; opts: unknown }[] = [];
    mocks.createSupabaseServiceRoleClient.mockReturnValue({ storage: mockStorage(signed) });

    const res = await GET(jsonRequest("http://t/api/vendor/documents/signed-url?kind=insurance&download=1"));
    expect(res.status).toBe(200);
    expect(signed[0]!.opts).toEqual({ download: "cert.pdf" });
  });

  it("404s when the caller has no linked manager record at all", async () => {
    mocks.resolveOwnVendorRecords.mockResolvedValue([]);
    mocks.createSupabaseServiceRoleClient.mockReturnValue({ storage: mockStorage([]) });

    const res = await GET(jsonRequest("http://t/api/vendor/documents/signed-url?kind=insurance"));
    const { status, data } = await parseJsonResponse<{ error?: string }>(res);
    expect(status).toBe(404);
    expect(data.error).toMatch(/not found/i);
  });

  it("404s a foreign document — a path outside the caller's own prefix is never signed, even if returned by the records lookup", async () => {
    mocks.resolveOwnVendorRecords.mockResolvedValue(
      ownRecordWithDoc("vendor-documents/some-other-vendor/insurance-1.pdf"),
    );
    const signed: { path: string; ttl: number; opts: unknown }[] = [];
    mocks.createSupabaseServiceRoleClient.mockReturnValue({ storage: mockStorage(signed) });

    const res = await GET(jsonRequest("http://t/api/vendor/documents/signed-url?kind=insurance"));
    const { status, data } = await parseJsonResponse<{ error?: string }>(res);
    expect(status).toBe(404);
    expect(data.error).toMatch(/not found/i);
    expect(signed).toHaveLength(0);
  });

  it("404s a kind the vendor never uploaded", async () => {
    mocks.resolveOwnVendorRecords.mockResolvedValue([
      {
        id: "mv-1",
        managerUserId: "mgr-1",
        row: { id: "mv-1", managerUserId: "mgr-1", vendorDocuments: [], updatedAt: "2026-01-01T00:00:00.000Z" },
      },
    ]);
    mocks.createSupabaseServiceRoleClient.mockReturnValue({ storage: mockStorage([]) });

    const res = await GET(jsonRequest("http://t/api/vendor/documents/signed-url?kind=insurance"));
    expect(res.status).toBe(404);
  });
});
