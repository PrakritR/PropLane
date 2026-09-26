// @vitest-environment jsdom
/**
 * Regression for a real bug: the Documents panel's inline "Replace" (and the
 * upload wizard's "Upload") posted `FormData` to `/api/vendor/documents/upload`,
 * which only ever parses a JSON body with a `dataUrl` string — the route's
 * `req.json()` throws on a multipart body, so both flows silently failed with
 * a generic "Upload failed." toast. The fix moved the client onto
 * `readVendorDocumentDataUrl` (File -> data URL) + a JSON POST, the same
 * shape `vendor-documents-storage-routes.test.ts` already proves the route
 * accepts.
 *
 * This exercises the REAL client-side conversion (`readVendorDocumentDataUrl`,
 * jsdom's own FileReader) feeding the REAL route handler end to end — a
 * round trip a component-level render test would only be able to assert
 * indirectly through a mocked `fetch`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readVendorDocumentDataUrl } from "@/lib/vendor-documents";

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

const VENDOR_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveVendorPortalUserId.mockResolvedValue({ ok: true, userId: VENDOR_ID });
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
            fileName: "old-cert.pdf",
            storagePath: `vendor-documents/${VENDOR_ID}/insurance-old.pdf`,
            url: "/api/vendor/documents/signed-url?kind=insurance",
            uploadedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    },
  ]);
});

describe("vendor documents Replace round-trips through the real upload route", () => {
  it("reads the picked File as a data URL and the route accepts the resulting JSON POST — the exact request the panel's Replace and the upload wizard now both send", async () => {
    const uploaded: string[] = [];
    const updatedRows: Record<string, unknown>[] = [];
    mocks.createSupabaseServiceRoleClient.mockReturnValue({
      storage: {
        from: (bucket: string) => ({
          upload: async (path: string) => {
            expect(bucket).toBe("vendor-documents");
            uploaded.push(path);
            return { error: null };
          },
        }),
      },
      from: () => ({
        update: (patch: Record<string, unknown>) => ({
          eq: async () => {
            updatedRows.push(patch);
            return { error: null };
          },
        }),
      }),
    });

    // The replacement file, exactly as a hidden <input type="file"> hands it
    // to `uploadFile`/`finish` — a real jsdom File, never a hand-built dataUrl.
    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "new-cert.pdf", {
      type: "application/pdf",
    });

    const dataUrl = await readVendorDocumentDataUrl(file);
    expect(dataUrl.startsWith("data:application/pdf;base64,")).toBe(true);

    const { POST } = await import("@/app/api/vendor/documents/upload/route");
    const res = await POST(
      new Request("http://t/api/vendor/documents/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "insurance", dataUrl, fileName: file.name }),
      }),
    );
    const data = (await res.json()) as {
      document?: { kind: string; fileName: string; storagePath: string };
      documents?: { kind: string; fileName: string }[];
      error?: string;
    };

    expect(res.status).toBe(200);
    expect(data.error).toBeUndefined();
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]).toMatch(new RegExp(`^vendor-documents/${VENDOR_ID}/insurance-`));
    expect(data.document?.fileName).toBe("new-cert.pdf");
    // The replacement supersedes the prior insurance doc rather than adding a
    // second one — merged by kind, one row per kind.
    expect(data.documents?.filter((d) => d.kind === "insurance")).toHaveLength(1);
    expect(data.documents?.find((d) => d.kind === "insurance")?.fileName).toBe("new-cert.pdf");
    expect(updatedRows).toHaveLength(1);
  });

  it("never sends FormData any more — the previously-broken shape is refused as a plain JSON parse failure", async () => {
    mocks.createSupabaseServiceRoleClient.mockReturnValue({ storage: { from: () => ({ upload: vi.fn() }) } });
    const body = new FormData();
    body.set("kind", "insurance");
    body.set("file", new File(["x"], "x.pdf", { type: "application/pdf" }));

    const { POST } = await import("@/app/api/vendor/documents/upload/route");
    const res = await POST(new Request("http://t/api/vendor/documents/upload", { method: "POST", body }));
    const data = (await res.json()) as { error?: string };

    // This is the regression itself: a FormData body still 500s with a
    // generic message rather than succeeding — proving Replace's OLD request
    // shape genuinely never worked, and why the fix moved the client instead
    // of widening the route (docs/agents/… "prefer the client change").
    expect(res.status).toBe(500);
    expect(data.error).toBeTruthy();
  });
});
