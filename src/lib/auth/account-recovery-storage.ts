import type { SupabaseClient } from "@supabase/supabase-js";

const PHYSICAL_STORAGE = Symbol("account-recovery-physical-storage");

/** Lifecycle workers must never reinterpret an old physical key as a recovered logical asset. */
function physicalStorage(db: SupabaseClient): SupabaseClient["storage"] {
  return (db as SupabaseClient & { [PHYSICAL_STORAGE]?: SupabaseClient["storage"] })[PHYSICAL_STORAGE] ?? db.storage;
}

export type RecoveryObject = {
  id: string;
  bucket: string;
  logical_path: string;
  source_bucket: string;
  source_path: string;
  generation: string;
  private_path: string;
  state: "copying" | "retained" | "active" | "purging" | "purged";
  copied: boolean;
  source_removed: boolean;
};

function check(error: { message: string } | null) {
  if (error) throw new Error(error.message);
}

/** Archive each immutable physical generation before the existing manifest removes it. */
export async function retainRecoveryObject(db: SupabaseClient, requestId: string, bucket: string, path: string): Promise<void> {
  const storage = physicalStorage(db);
  const { data, error } = await db.rpc("account_recovery_register_object", {
    p_request: requestId, p_bucket: bucket, p_path: path, p_encoded: encodeURIComponent(path),
    p_public_url: storage.from(bucket).getPublicUrl(path).data.publicUrl,
  });
  check(error);
  const object = (Array.isArray(data) ? (data.length === 1 ? data[0] : null) : data) as RecoveryObject | null;
  if (!object?.id) throw new Error("Recovery object registration failed.");
  if (object.state === "retained" || object.state === "active") return;
  if (object.state !== "copying") throw new Error("Recovery object is not ready to archive.");
  if (!object.copied) {
    const copied = await storage.from(object.source_bucket).copy(object.source_path, object.private_path, { destinationBucket: "account-recovery" });
    if (copied.error) {
      // A retry may encounter our earlier successful immutable copy. Verify it
      // against the original bytes; a vague duplicate error is not proof.
      const [source, destination] = await Promise.all([
        storage.from(object.source_bucket).download(object.source_path),
        storage.from("account-recovery").download(object.private_path),
      ]);
      check(source.error); check(destination.error);
      if (!source.data || !destination.data) throw new Error("Recovery copy verification failed.");
      const { createHash } = await import("node:crypto");
      const checksum = async (blob: Blob) => createHash("sha256").update(Buffer.from(await blob.arrayBuffer())).digest("hex");
      const [originalHash, copiedHash] = await Promise.all([checksum(source.data), checksum(destination.data)]);
      if (originalHash !== copiedHash) throw new Error("Recovery copy does not match the original.");
    }
    const progress = await db.rpc("account_recovery_object_progress", {
      p_object: object.id, p_generation: object.generation, p_copied: true, p_removed: false,
    });
    check(progress.error);
    if (!progress.data) throw new Error("Recovery object generation changed.");
  }
  if (!object.source_removed) {
    check((await storage.from(object.source_bucket).remove([object.source_path])).error);
    const progress = await db.rpc("account_recovery_object_progress", {
      p_object: object.id, p_generation: object.generation, p_copied: true, p_removed: true,
    });
    check(progress.error);
    if (!progress.data) throw new Error("Recovery object generation changed.");
  }
}

/** A deletion-only adapter: Prakrit's folder discovery and manifest remain the spine. */
export function withAccountRecoveryStorage<T extends SupabaseClient>(db: T, requestId: string): T {
  const storage = new Proxy(db.storage, {
    get(target, property) {
      if (property !== "from") return Reflect.get(target, property, target);
      return (bucket: string) => {
        const bucketClient = target.from(bucket);
        return new Proxy(bucketClient, {
          get(original, member) {
            if (member === "remove") return async (paths: string[]) => {
              for (const path of paths) await retainRecoveryObject(db, requestId, bucket, path);
              return { data: [], error: null };
            };
            const value = Reflect.get(original, member, original);
            return typeof value === "function" ? value.bind(original) : value;
          },
        });
      };
    },
  });
  return new Proxy(db, {
    get(target, property) {
      if (property === "storage") return storage;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

/** Call only after the original logical attachment's normal authorization check. */
export async function resolveRecoveryObject(db: SupabaseClient, bucket: string, logicalPath: string) {
  const { data, error } = await db.rpc("account_recovery_resolve_object", { p_bucket: bucket, p_path: logicalPath });
  check(error);
  if (!data) return { bucket, path: logicalPath };
  if (data.state !== "active") throw new Error("This attachment is unavailable.");
  return { bucket: String(data.bucket), path: String(data.path) };
}

/**
 * Existing callers still authorize and decrypt using the ORIGINAL logical path.
 * Only a failed physical read resolves to an explicitly recovered generation.
 * Normal files incur no extra database request.
 */
export function withRecoveredStorageReads<T extends SupabaseClient>(db: T): T {
  const storage = new Proxy(db.storage, {
    get(target, property) {
      if (property !== "from") return Reflect.get(target, property, target);
      return (bucket: string) => {
        const original = target.from(bucket);
        if (bucket === "account-recovery") return original;
        return new Proxy(original, {
          get(client, member) {
            if (member === "remove") return async (paths: string[]) => {
              const originals: string[] = [];
              for (const path of paths) {
                const prepared = await db.rpc("account_recovery_prepare_file_removal", { p_bucket: bucket, p_path: path });
                check(prepared.error);
                if (!prepared.data) { originals.push(path); continue; }
                check((await target.from("account-recovery").remove([String(prepared.data.path)])).error);
                const finished = await db.rpc("account_recovery_finish_object_purge", {
                  p_object: prepared.data.id, p_generation: prepared.data.generation,
                });
                check(finished.error);
                if (!finished.data) throw new Error("File deletion generation changed.");
              }
              return originals.length ? client.remove(originals) : { data: [], error: null };
            };
            if (member === "download") return async (...args: Parameters<typeof client.download>) => {
              const result = await client.download(...args);
              if (!result.error) return result;
              const mapped = await resolveRecoveryObject(db, bucket, args[0]);
              if (mapped.bucket === bucket && mapped.path === args[0]) return result;
              return target.from(mapped.bucket).download(mapped.path, args[1]);
            };
            if (member === "createSignedUrl") return async (...args: Parameters<typeof client.createSignedUrl>) => {
              const result = await client.createSignedUrl(...args);
              if (!result.error) return result;
              const mapped = await resolveRecoveryObject(db, bucket, args[0]);
              if (mapped.bucket === bucket && mapped.path === args[0]) return result;
              return target.from(mapped.bucket).createSignedUrl(mapped.path, args[1], args[2]);
            };
            if (member === "createSignedUrls") return async (...args: Parameters<typeof client.createSignedUrls>) => {
              const result = await client.createSignedUrls(...args);
              if (result.error || !result.data) return result;
              return { ...result, data: await Promise.all(result.data.map(async entry => {
                if (!entry.error || !entry.path) return entry;
                const mapped = await resolveRecoveryObject(db, bucket, entry.path);
                if (mapped.bucket === bucket && mapped.path === entry.path) return entry;
                const signed = await target.from(mapped.bucket).createSignedUrl(mapped.path, args[1], args[2]);
                return signed.error ? { ...entry, error: signed.error.message } : { ...entry, error: null, signedUrl: signed.data.signedUrl };
              })) };
            };
            const value = Reflect.get(client, member, client);
            return typeof value === "function" ? value.bind(client) : value;
          },
        });
      };
    },
  });
  return new Proxy(db, {
    get(target, property) {
      if (property === PHYSICAL_STORAGE) return target.storage;
      if (property === "storage") return storage;
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
