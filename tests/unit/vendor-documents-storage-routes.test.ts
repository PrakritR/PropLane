import { beforeEach, describe, expect, it, vi } from "vitest";
import { jsonRequest, parseJsonResponse } from "../helpers/api-request";

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

import { POST as UPLOAD } from "@/app/api/vendor/documents/upload/route";
import { GET as DOWNLOAD } from "@/app/api/vendor/documents/file/route";
import { VENDOR_DOCUMENTS_BUCKET } from "@/lib/vendor-documents-storage";

const VENDOR_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const PDF_DATA_URL = "data:application/pdf;base64,JVBERi0xLjQK";

function mockStorage(uploaded: string[] = [], signed: { path: string; opts: unknown }[] = []) {
  const storage = {
    from: (bucket: string) => ({
      upload: async (path: string) => {
        if (bucket !== VENDOR_DOCUMENTS_BUCKET) {
          return { error: { message: `unexpected bucket ${bucket}` } };
        }
        uploaded.push(path);
        return { error: null };
      },
      createSignedUrl: async (path: string, _ttlSeconds: number, opts?: unknown) => {
        if (bucket !== VENDOR_DOCUMENTS_BUCKET) {
          return { data: null, error: { message: `unexpected bucket ${bucket}` } };
        }
        signed.push({ path, opts });
        return { data: { signedUrl: `https://storage.example/${path}?sig=mock` }, error: null };
      },
    }),
  };
  return storage;
}

describe("vendor documents storage routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveVendorPortalUserId.mockResolvedValue({ ok: true, userId: VENDOR_ID });
    mocks.resolveOwnVendorRecords.mockResolvedValue([
      {
        id: "mv-1",
        managerUserId: "mgr-1",
        row: { id: "mv-1", managerUserId: "mgr-1", vendorDocuments: [], updatedAt: "2026-01-01T00:00:00.000Z" },
      },
    ]);
  });

  it("uploads to the private vendor-documents bucket", async () => {
    const uploaded: string[] = [];
    const updated: Record<string, unknown>[] = [];
    mocks.createSupabaseServiceRoleClient.mockReturnValue({
      storage: mockStorage(uploaded),
      from: () => ({
        update: (patch: Record<string, unknown>) => ({
          eq: async () => {
            updated.push(patch);
            return { error: null };
          },
        }),
      }),
    });

    const res = await UPLOAD(
      jsonRequest("http://t/api/vendor/documents/upload", {
        method: "POST",
        body: { dataUrl: PDF_DATA_URL, kind: "insurance", fileName: "cert.pdf" },
      }),
    );
    const { status, data } = await parseJsonResponse<{ document?: { storagePath?: string } }>(res);

    expect(status).toBe(200);
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]).toMatch(new RegExp(`^vendor-documents/${VENDOR_ID}/insurance-`));
    expect(data.document?.storagePath).toBe(uploaded[0]);
    expect(updated[0]?.row_data).toBeTruthy();
  });

  it("refuses unauthenticated download", async () => {
    mocks.resolveVendorPortalUserId.mockResolvedValue({ ok: false, status: 401 });
    mocks.createSupabaseServiceRoleClient.mockReturnValue({ storage: mockStorage() });

    const res = await DOWNLOAD(jsonRequest("http://t/api/vendor/documents/file?kind=insurance"));
    const { status, data } = await parseJsonResponse<{ error?: string }>(res);

    expect(status).toBe(401);
    expect(data.error).toMatch(/unauthorized/i);
  });

  it("never streams bytes any more — redirects to a freshly minted signed URL for the owner", async () => {
    const storagePath = `vendor-documents/${VENDOR_ID}/insurance-1.pdf`;
    const signed: { path: string; opts: unknown }[] = [];
    mocks.resolveOwnVendorRecords.mockResolvedValue([
      {
        id: "mv-1",
        managerUserId: "mgr-1",
        row: {
          id: "mv-1",
          managerUserId: "mgr-1",
          vendorDocuments: [
            {
              kind: "insurance",
              fileName: "cert.pdf",
              storagePath,
              url: "/api/vendor/documents/signed-url?kind=insurance",
              uploadedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    ]);
    mocks.createSupabaseServiceRoleClient.mockReturnValue({ storage: mockStorage([], signed) });

    const res = await DOWNLOAD(jsonRequest("http://t/api/vendor/documents/file?kind=insurance"));
    expect(res.status).toBe(302);
    expect(signed).toEqual([{ path: storagePath, opts: undefined }]);
    expect(res.headers.get("location")).toBe(`https://storage.example/${storagePath}?sig=mock`);
  });

  it("404s a foreign vendor's kind — never signs a path outside the caller's own prefix", async () => {
    mocks.resolveOwnVendorRecords.mockResolvedValue([
      {
        id: "mv-1",
        managerUserId: "mgr-1",
        row: {
          id: "mv-1",
          managerUserId: "mgr-1",
          vendorDocuments: [
            {
              kind: "insurance",
              fileName: "cert.pdf",
              storagePath: "vendor-documents/some-other-vendor/insurance-1.pdf",
              url: "/api/vendor/documents/signed-url?kind=insurance",
              uploadedAt: "2026-01-01T00:00:00.000Z",
            },
          ],
          updatedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    ]);
    const signed: { path: string; opts: unknown }[] = [];
    mocks.createSupabaseServiceRoleClient.mockReturnValue({ storage: mockStorage([], signed) });

    const res = await DOWNLOAD(jsonRequest("http://t/api/vendor/documents/file?kind=insurance"));
    const { status, data } = await parseJsonResponse<{ error?: string }>(res);
    expect(status).toBe(404);
    expect(data.error).toMatch(/not found/i);
    expect(signed).toHaveLength(0);
  });
});
