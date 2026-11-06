import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { cleanupSplitBDraft, preflightSplitBDraftOnDev, type SplitBDraftManifest } from "../../helpers/split-b-draft-proof";
async function main() {
  const dir = process.env.SPLIT_B_PRIVATE_DIR, url = process.env.NEXT_PUBLIC_SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!dir || !path.isAbsolute(dir) || url !== "https://emstjswhotsnyksqhqyf.supabase.co" || !key || process.env.SPLIT_B_SERVER_EXIT_VERIFIED !== "1") throw new Error("Invalid split-B cleanup context.");
  const file = path.join(dir, "split-b-manifest.json");
  if (!existsSync(file)) return; // No request passed the prewrite reservation.
  const manifest = JSON.parse(readFileSync(file, "utf8")) as SplitBDraftManifest;
  const db = createClient(url, key, { auth: { persistSession: false } });
  await cleanupSplitBDraft(db, manifest, file, { serverStopped: true, preflight: preflightSplitBDraftOnDev });
}
void main().catch(() => { process.exitCode = 1; });
