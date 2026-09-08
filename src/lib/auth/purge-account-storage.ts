import type { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

type ServiceDb = ReturnType<typeof createSupabaseServiceRoleClient>;

/** Remove actual bytes through Storage's API, including nested folders and >1 page. */
export async function purgeAccountStorageFolder(
  db: ServiceDb, bucket: string, folder: string,
  keepReferenced?: (paths: string[]) => Promise<Set<string>>,
): Promise<void> {
  if (!folder || folder.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("Account storage cleanup requires an explicit owner folder.");
  }
  const storage = db.storage.from(bucket);
  // Collect before deleting so offsets do not skip objects as the listing shrinks.
  const paths: string[] = [];
  async function collect(prefix: string): Promise<void> {
    for (let offset = 0; ; offset += 100) {
      const { data, error } = await storage.list(prefix, { limit: 100, offset, sortBy: { column: "name", order: "asc" } });
      if (error) {
        // A bucket absent in an older environment has no objects to reclaim.
        if (error.message === "Bucket not found") return;
        throw new Error(`Account storage cleanup failed (${bucket}): ${error.message}`);
      }
      for (const entry of data ?? []) {
        if (!entry.name || entry.name.includes("/") || entry.name === "." || entry.name === "..") {
          throw new Error("Invalid object name during account storage cleanup.");
        }
        if (entry.id === null) await collect(`${prefix}/${entry.name}`);
        else paths.push(`${prefix}/${entry.name}`);
      }
      if (!data || data.length < 100) break;
    }
  }
  await collect(folder);
  for (let i = 0; i < paths.length; i += 100) {
    const batch = paths.slice(i, i + 100);
    const retained = keepReferenced ? await keepReferenced(batch) : new Set<string>();
    const disposable = batch.filter(path => !retained.has(path));
    if (!disposable.length) continue;
    const { error } = await storage.remove(disposable);
    if (error) throw new Error(`Account storage cleanup failed (${bucket}): ${error.message}`);
  }
}
