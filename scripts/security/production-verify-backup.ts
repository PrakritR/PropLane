import { readFileSync, lstatSync } from "node:fs";
import { isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { decryptProductionSnapshot, MAX_SNAPSHOT_BYTES } from "./production-backup";

// Offline authentication check only: never restore data or connect to a provider.
try {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !isAbsolute(args[0])) throw new Error("One absolute encrypted backup path required.");
  const stat = lstatSync(args[0]);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SNAPSHOT_BYTES * 2 || (stat.mode & 0o077) !== 0) throw new Error("Private backup file required.");
  const archive = readFileSync(args[0], "utf8");
  const snapshot = decryptProductionSnapshot(archive);
  for (const object of snapshot.objects) {
    if (createHash("sha256").update(Buffer.from(object.bytes, "base64")).digest("hex") !== object.sha256) throw new Error("Object checksum mismatch.");
  }
  console.log(JSON.stringify({ verified: true, kind: snapshot.kind,
    rows: Object.fromEntries(Object.entries(snapshot.rows).map(([table, rows]) => [table, rows.length])),
    objects: snapshot.objects.length, sha256: createHash("sha256").update(archive).digest("hex") }));
} catch {
  console.error("Encrypted backup verification failed. No decrypted content or key details are logged.");
  process.exitCode = 1;
}
