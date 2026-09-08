import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { retainRecoveryObject, resolveRecoveryObject, withAccountRecoveryStorage, withRecoveredStorageReads } from "@/lib/auth/account-recovery-storage";

function fixture(overrides = {}) {
  const object = { id: "object", bucket: "manager-documents", logical_path: "manager/user/file", source_bucket: "manager-documents", source_path: "manager/user/file", generation: "generation", private_path: "generation/bytes", state: "copying", copied: false, source_removed: false, ...overrides };
  const remove = vi.fn().mockResolvedValue({ error: null });
  const copy = vi.fn().mockResolvedValue({ error: null });
  const download = vi.fn().mockResolvedValue({ data: new Blob(["original bytes"]), error: null });
  const from = vi.fn(() => ({ remove, copy, download, getPublicUrl: () => ({ data: { publicUrl: "https://example.test/file" } }) }));
  const rpc = vi.fn(async (name: string) => ({ data: name === "account_recovery_register_object" ? object : true, error: null }));
  const db = { storage: { from }, rpc } as unknown as SupabaseClient;
  return { db, object, rpc, remove, copy, download, from };
}

describe("immutable recovery storage", () => {
  it("copies and records progress before removing only the old physical source", async () => {
    const f = fixture();
    await retainRecoveryObject(f.db, "request", f.object.bucket, f.object.logical_path);
    expect(f.copy).toHaveBeenCalledWith(f.object.source_path, "generation/bytes", { destinationBucket: "account-recovery" });
    expect(f.remove).toHaveBeenCalledExactlyOnceWith(f.object.source_path ? [f.object.source_path] : []);
    expect(f.rpc.mock.calls.map(call => call[0])).toEqual(["account_recovery_register_object", "account_recovery_object_progress", "account_recovery_object_progress"]);
    expect(f.copy.mock.invocationCallOrder[0]).toBeLessThan(f.remove.mock.invocationCallOrder[0]);
  });
  it("does not delete a source when the generation claim is lost", async () => {
    const f = fixture();
    f.rpc.mockImplementation(async (name: string) => ({ data: name === "account_recovery_register_object" ? f.object : false, error: null }));
    await expect(retainRecoveryObject(f.db, "request", f.object.bucket, f.object.logical_path)).rejects.toThrow(/generation changed/);
    expect(f.remove).not.toHaveBeenCalled();
  });
  it("verifies bytes after a duplicate copy before accepting an interrupted retry", async () => {
    const f = fixture();
    f.copy.mockResolvedValue({ error: { message: "Already exists" } });
    await retainRecoveryObject(f.db, "request", f.object.bucket, f.object.logical_path);
    expect(f.download).toHaveBeenCalledTimes(2);
    expect(f.remove).toHaveBeenCalledOnce();
  });
  it("rejects mismatching copied bytes and preserves the source", async () => {
    const f = fixture();
    f.copy.mockResolvedValue({ error: { message: "Already exists" } });
    f.download.mockResolvedValueOnce({ data: new Blob(["original"]), error: null }).mockResolvedValueOnce({ data: new Blob(["wrong"]), error: null });
    await expect(retainRecoveryObject(f.db, "request", f.object.bucket, f.object.logical_path)).rejects.toThrow(/does not match/);
    expect(f.remove).not.toHaveBeenCalled();
  });
  it("retries failed source deletion without copying again", async () => {
    const f = fixture({ copied: true });
    f.remove.mockResolvedValueOnce({ error: { message: "storage unavailable" } });
    await expect(retainRecoveryObject(f.db, "request", f.object.bucket, f.object.logical_path)).rejects.toThrow(/storage unavailable/);
    await retainRecoveryObject(f.db, "request", f.object.bucket, f.object.logical_path);
    expect(f.copy).not.toHaveBeenCalled();
    expect(f.remove).toHaveBeenCalledTimes(2);
  });
  it("archives a restored generation from private storage, never the original logical path", async () => {
    const f = fixture({ source_bucket: "account-recovery", source_path: "previous-generation/bytes" });
    await retainRecoveryObject(f.db, "request", f.object.bucket, f.object.logical_path);
    expect(f.copy).toHaveBeenCalledWith("previous-generation/bytes", "generation/bytes", { destinationBucket: "account-recovery" });
    expect(f.remove).toHaveBeenCalledWith(["previous-generation/bytes"]);
  });
  it("adapts the existing manifest removal without recursive wrapping", async () => {
    const f = fixture();
    const adapted = withAccountRecoveryStorage(f.db, "request");
    await adapted.storage.from(f.object.bucket).remove([f.object.logical_path]);
    expect(f.copy).toHaveBeenCalledOnce();
    expect(f.remove).toHaveBeenCalledOnce();
  });
  it.each(["copying", "retained", "purging", "purged"])("denies reads in state %s", async state => {
    const f = fixture();
    f.rpc.mockResolvedValue({ data: { state, bucket: "account-recovery", path: "generation/bytes" } as never, error: null });
    await expect(resolveRecoveryObject(f.db, f.object.bucket, f.object.logical_path)).rejects.toThrow(/unavailable/);
  });
});


it("a delayed lifecycle worker never resolves its old physical source to a recovered logical generation", async () => {
  const f = fixture();
  f.rpc.mockImplementation(async (name: string) => {
    if (name === "account_recovery_register_object") return { data: f.object, error: null };
    // Another worker can finish and the user can recover after our durable copy
    // progress, before this worker's remove executes. A logical removal would
    // now target the newly recovered generation; physical removal must not.
    if (name === "account_recovery_prepare_file_removal") return { data: { id: "object", generation: "new-generation", path: "new-generation/bytes" } as never, error: null };
    return { data: true, error: null };
  });
  const composed = withAccountRecoveryStorage(withRecoveredStorageReads(f.db), "request");
  await composed.storage.from(f.object.bucket).remove([f.object.logical_path]);
  expect(f.remove).toHaveBeenCalledExactlyOnceWith([f.object.source_path]);
  expect(f.rpc.mock.calls.some(([name]) => name === "account_recovery_prepare_file_removal")).toBe(false);
});
