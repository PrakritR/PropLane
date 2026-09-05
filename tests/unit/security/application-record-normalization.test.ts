import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { persistRenamedApplicationRecord } from "@/lib/security/application-record-normalization.server";
import { openApplicantRow, prepareApplicantIdentityWrite, sealApplicantRow } from "@/lib/security/applicant-identity";
import { resolveApplicationDocumentStoragePath } from "@/lib/security/application-document-aliases.server";
import { createApplicationDocumentUploadEncryption, decryptApplicationDocumentBytes } from "@/lib/security/application-document-crypto.server";
import { encryptApplicationDocumentUpload } from "@/lib/security/application-document-format";

const oldId = "abc123";
const newId = "PROPLANE-ABC123";
const owner = "11111111-1111-4111-8111-111111111111";
const originalPath = `application/${newId}/legacy.pdf`;
const encryptedPath = `application/${newId}/migration-test.pdf.penc`;
beforeEach(() => {
  vi.stubEnv("DATA_ENCRYPTION_ACTIVE_KEY_ID", "test");
  vi.stubEnv("DATA_ENCRYPTION_KEYS_JSON", JSON.stringify({ test: randomBytes(32).toString("base64") }));
});
afterEach(() => vi.unstubAllEnvs());

it("rekeys exact applicant identity while migrated legacy document paths and AAD remain usable", async () => {
  const source = { id: oldId, managerUserId: owner, application: { ssn: "123-45-6789", dateOfBirth: "1980-01-02", idPhotoFront: { path: originalPath } } } as unknown as DemoApplicantRow;
  const existing = { id: oldId, manager_user_id: owner, row_data: sealApplicantRow(source, oldId, owner) };
  const prepared = prepareApplicantIdentityWrite({ ...source, id: newId }, existing.row_data, oldId);
  const next = { id: newId, manager_user_id: owner, row_data: sealApplicantRow(prepared, newId, owner) };
  const rpc = vi.fn(async () => ({ error: null }));
  await persistRenamedApplicationRecord({ rpc } as unknown as SupabaseClient, existing, next);
  expect(rpc).toHaveBeenCalledWith("normalize_application_record_id", expect.objectContaining({ p_old_id: oldId, p_next: next, p_expected: expect.objectContaining({ row_data: existing.row_data, manager_user_id: owner }) }));
  expect(openApplicantRow(next.row_data, newId).application?.ssn).toBe("123-45-6789");
  expect(() => openApplicantRow(next.row_data, oldId)).toThrow();
  expect(next.row_data.application?.idPhotoFront).toEqual({ path: originalPath });

  const bytes = new Blob(["%PDF synthetic sensitive document"]);
  const encrypted = await encryptApplicationDocumentUpload(bytes, encryptedPath, createApplicationDocumentUploadEncryption(encryptedPath, bytes.size));
  const filters = new Map<string,string>();
  const builder = { select: () => builder, eq: (key: string, value: string) => { filters.set(key,value); return builder; }, maybeSingle: async () => ({ error: null, data: filters.get("application_id") === newId ? { encrypted_path: encryptedPath } : null }) };
  const path = await resolveApplicationDocumentStoragePath({ from: () => builder } as unknown as SupabaseClient, newId, originalPath);
  expect(path).toBe(encryptedPath);
  expect(decryptApplicationDocumentBytes(Buffer.from(await encrypted.arrayBuffer()), path).toString()).toBe(await bytes.text());
  expect(() => decryptApplicationDocumentBytes(Buffer.from("invalid"), `application/OTHER/migration-test.pdf.penc`)).toThrow();
});

it("rejects changing to another application's folder before touching the database", async () => {
  const rpc = vi.fn();
  await expect(persistRenamedApplicationRecord({ rpc } as unknown as SupabaseClient,
    { id: oldId,row_data: {} }, { id: "PROPLANE-OTHER",row_data: {} })).rejects.toThrow(/safely/);
  expect(rpc).not.toHaveBeenCalled();
});

it("surfaces transaction failure without retrying separate alias moves or deleting old rows", async () => {
  const rpc = vi.fn(async () => ({ error: { message: "private database detail" } }));
  const from = vi.fn();
  await expect(persistRenamedApplicationRecord({ rpc, from } as unknown as SupabaseClient,
    { id: oldId,row_data: {} }, { id: newId,row_data: {} })).rejects.toThrow("Application normalization could not be completed safely. Refresh and retry.");
  expect(from).not.toHaveBeenCalled();
  expect(rpc).toHaveBeenCalledOnce();
});
