import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encryptApplicationDocumentUpload } from "@/lib/security/application-document-format";
import { hashResidentSetupToken } from "@/lib/auth/resident-setup-token";

const mocks = vi.hoisted(() => ({
  user: { id: "mgr-a", email: "manager@example.test" } as { id: string; email: string } | null,
  row: {} as Record<string, unknown>,
  alias: null as null | { encrypted_path: string },
  aliasError: false,
  download: vi.fn(), sign: vi.fn(), remove: vi.fn(),
}));
vi.mock("@/lib/auth/admin-preview", () => ({ isAdminUser: async () => false }));
vi.mock("@/lib/auth/co-manager-module-scope", () => ({ linkedPropertyIdsForModule: async () => [] }));
vi.mock("@/lib/rate-limit", () => ({ clientIpFrom: () => "test", rateLimit: async () => ({ ok: true }) }));
vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: { getUser: async () => ({ data: { user: mocks.user } }) } }),
}));
vi.mock("@/lib/supabase/service", () => ({
  createSupabaseServiceRoleClient: () => ({
    from: (table: string) => {
      const builder = {
        select: () => builder, in: () => builder, eq: () => builder,
        limit: async () => ({ data: [mocks.row], error: null }),
        maybeSingle: async () => table === "application_document_storage_aliases"
          ? { data: mocks.alias, error: mocks.aliasError ? { message: "unavailable" } : null }
          : { data: { role: "manager", email: mocks.user?.email }, error: null },
        then: (resolve: (value: unknown) => void) => resolve({ data: [], error: null }),
      };
      if (!["manager_application_records", "profiles", "manager_property_records", "application_document_storage_aliases"].includes(table)) throw new Error("Unexpected table");
      return builder;
    },
    storage: { from: () => ({
      list: async () => ({ data: [], error: null }),
      createSignedUploadUrl: mocks.sign, download: mocks.download, remove: mocks.remove,
    }) },
  }),
}));

import { DELETE, GET, POST } from "@/app/api/portal/application-photos/route";
const id = "PROPLANE-APP1";
const raw = Buffer.from("%PDF-1.7 synthetic income statement");
const signBody = { action: "sign", encryptionVersion: 1, applicationId: id, slot: "income", mimeType: "application/pdf", sizeBytes: raw.length };
const request = (body: object) => new Request("https://prop-lane.space/api/portal/application-photos", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});
const read = () => GET(new Request(`https://prop-lane.space/api/portal/application-photos?applicationId=${id}&slot=income`));

beforeEach(() => {
  vi.clearAllMocks();
  mocks.alias = null;
  mocks.aliasError = false;
  vi.stubEnv("DATA_ENCRYPTION_ACTIVE_KEY_ID", "test");
  vi.stubEnv("DATA_ENCRYPTION_KEYS_JSON", JSON.stringify({ test: randomBytes(32).toString("base64") }));
  vi.stubEnv("DATA_ENCRYPTION_REQUIRE_ENCRYPTED_DOCUMENT_READS", "");
  mocks.user = { id: "mgr-a", email: "manager@example.test" };
  mocks.row = { id, manager_user_id: "mgr-a", resident_email: "resident@example.test", row_data: { bucket: "pending", application: {} } };
  mocks.sign.mockResolvedValue({ data: { token: "signed-upload-token" }, error: null });
  mocks.remove.mockResolvedValue({ error: null });
});
afterEach(() => vi.unstubAllEnvs());

async function attachEncryptedDocument() {
  const signed = await POST(request(signBody));
  expect(signed.status).toBe(200);
  expect(signed.headers.get("Cache-Control")).toBe("private, no-store");
  const result = await signed.json();
  const ciphertext = await encryptApplicationDocumentUpload(new Blob([new Uint8Array(raw)]), result.path, result.encryption);
  mocks.download.mockResolvedValue({ data: ciphertext, error: null });
  mocks.row.row_data = { bucket: "pending", application: { incomeProofPhotos: [{ storagePath: result.path, fileName: "statement.pdf" }] } };
  return result;
}

describe("application document authorized upload/download", () => {
  it("signs an encrypted object and serves the exact decrypted PDF with private headers", async () => {
    const result = await attachEncryptedDocument();
    expect(result.path).toMatch(/\.pdf\.penc$/);
    const response = await read();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(raw);
  });

  it("denies a different manager before Storage download/decryption", async () => {
    await attachEncryptedDocument();
    mocks.user = { id: "mgr-b", email: "other@example.test" };
    expect((await read()).status).toBe(404);
    expect(mocks.download).not.toHaveBeenCalled();
    expect((await POST(request(signBody))).status).toBe(403);
    expect(mocks.sign).toHaveBeenCalledOnce();
  });

  it("allows the authenticated applicant and denies guest reads", async () => {
    await attachEncryptedDocument();
    mocks.user = { id: "resident", email: "resident@example.test" };
    expect((await read()).status).toBe(200);
    mocks.user = null;
    expect((await read()).status).toBe(404);
  });

  it("requires the stored guest setup token before issuing encryption material", async () => {
    mocks.user = null;
    mocks.row.row_data = { bucket: "pending", setupTokenHash: hashResidentSetupToken("guest-token"), setupTokenExpiresAt: new Date(Date.now() + 60_000).toISOString(), application: {} };
    expect((await POST(request(signBody))).status).toBe(403);
    expect(mocks.sign).not.toHaveBeenCalled();
    expect((await POST(request({ ...signBody, setupToken: "guest-token" }))).status).toBe(200);
  });

  it("rejects a plaintext upload at a protected path without serving the bytes", async () => {
    await attachEncryptedDocument();
    mocks.download.mockResolvedValue({ data: new Blob([raw]), error: null });
    const response = await read();
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain("income statement");
  });

  it("requires old tabs to refresh before minting an unusable upload", async () => {
    expect((await POST(request({ ...signBody, encryptionVersion: undefined }))).status).toBe(409);
    expect(mocks.sign).not.toHaveBeenCalled();
  });

  it("keeps a stale browser's original attachment reference readable through a same-application alias", async () => {
    const result = await attachEncryptedDocument();
    const originalPath = `application/${id}/income-old.pdf`;
    mocks.row.row_data = { application: { incomeProofPhotos: [{ storagePath: originalPath }] } };
    mocks.alias = { encrypted_path: result.path };
    const response = await read();
    expect(response.status).toBe(200);
    expect(mocks.download).toHaveBeenCalledWith(result.path);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(raw);
  });

  it("refuses aliases into another application before downloading bytes", async () => {
    await attachEncryptedDocument();
    mocks.row.row_data = { application: { incomeProofPhotos: [{ storagePath: `application/${id}/income-old.pdf` }] } };
    mocks.alias = { encrypted_path: "application/PROPLANE-OTHER/income-a.pdf.penc" };
    expect((await read()).status).toBe(404);
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("never falls back to original plaintext when the alias store is unavailable", async () => {
    mocks.row.row_data = { application: { incomeProofPhotos: [{ storagePath: `application/${id}/income-old.pdf` }] } };
    mocks.aliasError = true;
    expect((await read()).status).toBe(404);
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("keeps legacy objects readable until encrypted-only reads are enabled", async () => {
    mocks.row.row_data = { application: { incomeProofPhotos: [{ storagePath: `application/${id}/income-old.pdf` }] } };
    mocks.download.mockResolvedValue({ data: new Blob([raw]), error: null });
    expect((await read()).status).toBe(200);
    vi.stubEnv("DATA_ENCRYPTION_REQUIRE_ENCRYPTED_DOCUMENT_READS", "true");
    expect((await read()).status).toBe(404);
  });

  it("deleting an authorized migrated attachment removes original and encrypted object", async () => {
    const result = await attachEncryptedDocument();
    const sourcePath = `application/${id}/income-original.pdf`;
    mocks.alias = { encrypted_path: result.path };
    const response = await DELETE(request({ applicationId: id, storagePath: sourcePath }));
    expect(response.status).toBe(200);
    expect(mocks.remove).toHaveBeenCalledWith([sourcePath, result.path]);
  });

  it("denies a foreign manager's migrated-document deletion before Storage mutation", async () => {
    const result = await attachEncryptedDocument();
    mocks.alias = { encrypted_path: result.path };
    mocks.user = { id: "mgr-b", email: "other@example.test" };
    const response = await DELETE(request({ applicationId: id, storagePath: `application/${id}/income-original.pdf` }));
    expect(response.status).toBe(403);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
