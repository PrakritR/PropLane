import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { migrateApplicationDocumentObject } from "../../../scripts/security/application-document-backfill";
import { decryptApplicationDocumentBytes } from "@/lib/security/application-document-crypto.server";

const appId = "PROPLANE-APP1";
const originalPath = `application/${appId}/income-original.pdf`;
const original = Buffer.from("%PDF-1.7 private synthetic legacy bytes");
beforeEach(() => {
  vi.stubEnv("DATA_ENCRYPTION_ACTIVE_KEY_ID", "test");
  vi.stubEnv("DATA_ENCRYPTION_KEYS_JSON", JSON.stringify({ test: randomBytes(32).toString("base64") }));
});
afterEach(() => vi.unstubAllEnvs());

function fixtures() {
  const objects = new Map<string, Blob>([[originalPath, new Blob([original])]]);
  const events: string[] = [];
  const state = { alias: null as string | null, pending: null as string | null, failInsert: false, failCommit: false, failRemove: false, corruptUpload: false };
  const query = vi.fn(async (sql: string, values?: unknown[]) => {
    events.push(sql);
    if (sql.startsWith("select id")) return { rows: [{ id: appId }] };
    if (sql.startsWith("select encrypted_path")) return { rows: state.alias ? [{ encrypted_path: state.alias }] : [] };
    if (sql.startsWith("insert into")) {
      if (state.failInsert) throw new Error("insert failed");
      state.pending = String(values?.[2]);
    }
    if (sql === "commit") {
      state.alias = state.pending ?? state.alias;
      if (state.failCommit) throw new Error("commit response lost");
    }
    if (sql === "rollback") state.pending = null;
    return { rows: [] };
  });
  const upload = vi.fn(async (path: string, blob: Blob) => {
    events.push("upload");
    objects.set(path, state.corruptUpload ? new Blob(["corrupted"]) : blob);
    return { error: null };
  });
  const download = vi.fn(async (path: string) => {
    events.push(path === originalPath ? "download-original" : "verify-encrypted");
    return { data: objects.get(path) ?? null, error: null };
  });
  const remove = vi.fn(async (paths: string[]) => {
    events.push(paths.includes(originalPath) ? "remove-original" : "remove-output");
    if (state.failRemove && paths.includes(originalPath)) return { error: { message: "remove failed" } };
    for (const path of paths) objects.delete(path);
    return { error: null };
  });
  const storage = { storage: { from: () => ({ upload, download, remove }) } } as unknown as SupabaseClient;
  return { db: { query }, storage, objects, events, state, upload, remove };
}

it("locks application, verifies uploaded ciphertext, commits alias before removing plaintext", async () => {
  const f = fixtures();
  expect(await migrateApplicationDocumentObject(f.db, f.storage, appId, originalPath, true)).toBe("migrated");
  expect(f.events.some((sql) => sql.includes("for update"))).toBe(true);
  expect(f.events.filter((sql) => sql === "set local role postgres")).toHaveLength(2);
  expect(f.events.indexOf("verify-encrypted")).toBeLessThan(f.events.indexOf("commit"));
  expect(f.events.indexOf("commit")).toBeLessThan(f.events.indexOf("remove-original"));
  expect(f.objects.has(originalPath)).toBe(false);
  const ciphertext = Buffer.from(await f.objects.get(f.state.alias!)!.arrayBuffer());
  expect(decryptApplicationDocumentBytes(ciphertext, f.state.alias!)).toEqual(original);
  expect(f.events.some((sql) => sql.startsWith("update public.manager_application_records"))).toBe(false);
});

it("dry run validates crypto without uploads, alias writes or original deletion", async () => {
  const f = fixtures();
  expect(await migrateApplicationDocumentObject(f.db, f.storage, appId, originalPath, false)).toBe("candidate");
  expect(f.upload).not.toHaveBeenCalled();
  expect(f.remove).not.toHaveBeenCalled();
  expect(f.state.alias).toBeNull();
  expect(f.events).toContain("begin read only");
  expect(f.events).toContain("rollback");
});

it.each(["failInsert", "corruptUpload"] as const)("retains original and cleans output after %s", async (failure) => {
  const f = fixtures();
  f.state[failure] = true;
  await expect(migrateApplicationDocumentObject(f.db, f.storage, appId, originalPath, true)).rejects.toThrow();
  expect([...f.objects.keys()]).toEqual([originalPath]);
  expect(f.state.alias).toBeNull();
  expect(f.events).not.toContain("remove-original");
});

it("retains original and ciphertext after ambiguous commit so a durable alias stays usable", async () => {
  const f = fixtures();
  f.state.failCommit = true;
  await expect(migrateApplicationDocumentObject(f.db, f.storage, appId, originalPath, true)).rejects.toThrow();
  expect(f.state.alias).not.toBeNull();
  expect(f.objects.has(f.state.alias!)).toBe(true);
  expect(f.objects.has(originalPath)).toBe(true);
  expect(f.remove).not.toHaveBeenCalled();
});

it("retries cleanup after committed alias without creating a second encrypted object", async () => {
  const f = fixtures();
  f.state.failRemove = true;
  expect(await migrateApplicationDocumentObject(f.db, f.storage, appId, originalPath, true)).toBe("cleanup-pending");
  expect(f.objects.has(originalPath)).toBe(true);
  f.state.failRemove = false;
  expect(await migrateApplicationDocumentObject(f.db, f.storage, appId, originalPath, true)).toBe("migrated");
  expect(f.upload).toHaveBeenCalledOnce();
  expect(f.objects.has(originalPath)).toBe(false);
});
