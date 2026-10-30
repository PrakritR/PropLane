/** Invoked only by the dedicated runner after its proof server exits. */
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createClient } from "@supabase/supabase-js";
import { captureSyntheticManagerWorkspace, cleanupSyntheticManagerWorkspace, cleanupSyntheticManager, type SyntheticManagerManifest } from "../../helpers/synthetic-manager-cleanup";
import { preflightSyntheticWorkspaceOnDev, assertSyntheticSessionsAbsentOnDev } from "../../helpers/synthetic-workspace-preflight";

let stage = "validate";
async function main() {
const dir = process.env.AUTH_PROOF_CAPTURE_DIR;
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!dir || !path.isAbsolute(dir) || url !== "https://emstjswhotsnyksqhqyf.supabase.co" || !key || process.env.AUTH_PROOF_SERVER_EXIT_VERIFIED !== "1") throw new Error("Invalid cleanup environment.");
const files = readdirSync(dir).filter((name) => /^manager-[a-f0-9]{64}\.manifest\.json$/.test(name));
if (files.length === 0) { if (readdirSync(dir).some((name) => name !== "phases.json" && name !== "cleanup-status.json")) throw new Error("Untracked capture without manifest."); return; }
if (files.length !== 1) throw new Error("Expected exactly one private manifest.");
const file = path.join(dir, files[0]!);
stage = "load_manifest";
const manifest = JSON.parse(readFileSync(file, "utf8")) as SyntheticManagerManifest;
const db = createClient(url, key, { auth: { persistSession: false } });
if (!manifest.authId) { throw new Error("Synthetic Auth identity must be resolved before session inspection."); }
stage = "inspect_sessions";
await assertSyntheticSessionsAbsentOnDev(manifest.authId);
stage = "inspect_workspace";
const workspaces = await db.from("portal_workspaces").select("id").eq("owner_user_id", manifest.authId).limit(2);
if (workspaces.error || (workspaces.data?.length ?? 0) > 1) throw new Error("Unexpected workspace state.");
if (!workspaces.data?.length) { await cleanupSyntheticManager(db, url, manifest, file); return; }
stage = "capture_workspace";
await captureSyntheticManagerWorkspace(db, manifest, file, preflightSyntheticWorkspaceOnDev);
stage = "cleanup_workspace";
await cleanupSyntheticManagerWorkspace(db, url, manifest, file, { serverStopped: true, preflight: preflightSyntheticWorkspaceOnDev });

}
void main().then(() => { stage = "complete"; }).catch(() => { process.exitCode = 1; }).finally(() => {
  const dir = process.env.AUTH_PROOF_CAPTURE_DIR;
  if (dir && path.isAbsolute(dir)) writeFileSync(path.join(dir, "cleanup-status.json"), JSON.stringify({ stage, ok: process.exitCode !== 1 }), { mode: 0o600 });
});
