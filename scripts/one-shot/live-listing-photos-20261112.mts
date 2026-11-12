/**
 * ONE SHOT, captain waiver 2026-11-12 (.cursor/rules/no-production-live-listings.mdc, "photos only"):
 * replace the listing photos of the three live houses with each house's own curated photos.
 *
 * Writes ONLY the photo fields of `manager_property_records.property_data.listingSubmission`:
 *   - housePhotoDataUrls      (index 0 is the cover: every card reads `housePhotoDataUrls[0]`)
 *   - rooms[].photoDataUrls   (matched by room name "Room N")
 * Pricing, rooms, move-in, fees and every other field are left alone and verified byte-identical after the write.
 * Do not re-run on a house after a successful apply (an `.applied` marker next to the backup refuses it).
 *
 *   npx tsx --env-file=<env file> scripts/one-shot/live-listing-photos-20261112.mts --project-ref <ref> --house <5257|5259|4709A>
 *       dry run (default): prints the planned old -> new URL lists, touches nothing
 *   ... --apply
 *       backup the full row to ~/.cockpit/backups/live-photos-1112/<house>-<timestamp>.json FIRST, upload the files
 *       (bucket `listing-photos`, skipped when already there), update the photo fields, read back and verify
 *   ... --restore <backup.json>
 *       write back ONLY the photo fields recorded in a backup (verifies nothing else moved)
 *   ... --dev-test-record <id>
 *       DEV ONLY (project-ref must be the dev project): treat this throwaway row as the target of --house
 *
 * --project-ref is required and must equal the ref in NEXT_PUBLIC_SUPABASE_URL. Curated input:
 * ~/.cockpit/photos-1112/curated/<house>/{cover.jpg, house/NN.jpg, rooms/<n>/NN.jpg} (override: --curated-dir).
 */
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TABLE = "manager_property_records";
const BUCKET = "listing-photos";
const DEV_REF = "emstjswhotsnyksqhqyf";
const MAX_HOUSE_PHOTOS = 12; // normalizeManagerListingSubmissionV1 slices housePhotoDataUrls to 12
const MAX_ROOM_PHOTOS = 8; // ListingMediaPlacement MAX_SLOT_PHOTOS

/** The only ids this script will ever write (the waiver names exactly these). */
const HOUSES = {
  "5257": { id: "mgr-listing-1x3tiu0489ha", addressToken: "5257" },
  "5259": { id: "mgr-5257-brooklyn-ave-copy-9-rooms-7mbwr0uza0nq", addressToken: "5259" },
  "4709A": { id: "mgr-5259-brooklyn-ave-copy-9-rooms-7mdlyj0h2vfg", addressToken: "4709" },
} as const;
type HouseKey = keyof typeof HOUSES;
const WAIVER_IDS: string[] = Object.values(HOUSES).map((h) => h.id);

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Row = Record<string, Json> & { id: string; manager_user_id: string | null; property_data: Record<string, Json> };

function fail(message: string): never {
  console.error(`\none-shot FAILED: ${message}`);
  process.exit(1);
}

function argValue(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
}

function refFromUrl(url: string): string {
  try {
    return new URL(url).hostname.split(".")[0] ?? "";
  } catch {
    return "";
  }
}

/** Key-order independent serialization (jsonb does not preserve key order). */
function canon(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canon).join(",")}]`;
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>;
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canon(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function submissionOf(row: Row): Record<string, Json> {
  const s = row.property_data?.listingSubmission;
  if (!s || typeof s !== "object" || Array.isArray(s)) fail(`${row.id} has no property_data.listingSubmission`);
  return s as Record<string, Json>;
}

function roomsOf(sub: Record<string, Json>): Record<string, Json>[] {
  return Array.isArray(sub.rooms) ? (sub.rooms as Record<string, Json>[]) : [];
}

/** The row with the photo fields masked: what "every other field" is compared on. */
function maskedRow(row: Row): unknown {
  const copy = clone(row);
  const sub = copy.property_data?.listingSubmission as Record<string, Json> | undefined;
  if (sub && typeof sub === "object") {
    if ("housePhotoDataUrls" in sub) sub.housePhotoDataUrls = "<photo field>";
    for (const room of roomsOf(sub)) if ("photoDataUrls" in room) room.photoDataUrls = "<photo field>";
  }
  return copy;
}

type Plan = { house: string[]; rooms: Map<string, { name: string; urls: string[] }>; files: Map<string, { sha: string; file: string }> };

function listJpgs(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /\.jpe?g$/i.test(f)).sort().map((f) => path.join(dir, f));
}

function roomNumberOf(name: unknown): string | null {
  const m = typeof name === "string" ? name.match(/(?:^|[^a-z0-9])room\s*(\d+)\s*$/i) : null;
  return m ? String(Number(m[1])) : null;
}

function publicUrl(db: SupabaseClient, objectPath: string): string {
  return db.storage.from(BUCKET).getPublicUrl(objectPath).data.publicUrl;
}

function buildPlan(db: SupabaseClient, row: Row, curatedDir: string): Plan {
  const owner = row.manager_user_id;
  if (!owner) fail(`${row.id} has no manager_user_id (the bucket folder is the manager's id)`);
  const files = new Map<string, { sha: string; file: string }>();
  const urlFor = (file: string): string => {
    const bytes = fs.readFileSync(file);
    const sha = createHash("sha256").update(bytes).digest("hex");
    // Same scheme as the manager portal upload: <manager user id>/<unique name>.<ext>, in the same bucket. The unique
    // name is the content hash so a re-run (or a second house with the same bytes) finds the object already there.
    const objectPath = `${owner}/curated-1112-${sha.slice(0, 20)}.jpg`;
    files.set(objectPath, { sha, file });
    return publicUrl(db, objectPath);
  };
  const cover = path.join(curatedDir, "cover.jpg");
  if (!fs.existsSync(cover)) fail(`missing ${cover}`);
  const house = [urlFor(cover), ...listJpgs(path.join(curatedDir, "house")).map(urlFor)];
  if (house.length > MAX_HOUSE_PHOTOS) fail(`house gallery has ${house.length} photos; the listing keeps at most ${MAX_HOUSE_PHOTOS}`);

  const sub = submissionOf(row);
  const byNumber = new Map<string, Record<string, Json>[]>();
  for (const r of roomsOf(sub)) {
    const n = roomNumberOf(r.name);
    if (n) byNumber.set(n, [...(byNumber.get(n) ?? []), r]);
  }
  const rooms = new Map<string, { name: string; urls: string[] }>();
  const roomsDir = path.join(curatedDir, "rooms");
  const curatedRooms = fs.existsSync(roomsDir) ? fs.readdirSync(roomsDir).filter((d) => /^\d+$/.test(d)).sort((a, b) => Number(a) - Number(b)) : [];
  for (const n of curatedRooms) {
    const matches = byNumber.get(String(Number(n))) ?? [];
    if (matches.length !== 1) fail(`curated room ${n}: found ${matches.length} rooms named "Room ${n}" on ${row.id} (need exactly 1)`);
    const urls = listJpgs(path.join(roomsDir, n)).map(urlFor);
    if (urls.length > MAX_ROOM_PHOTOS) fail(`room ${n} has ${urls.length} photos; max ${MAX_ROOM_PHOTOS}`);
    rooms.set(String(matches[0].id), { name: String(matches[0].name), urls });
  }
  const unmatched = roomsOf(sub).filter((r) => !rooms.has(String(r.id)));
  if (unmatched.length) {
    console.warn(`note: ${unmatched.length} room(s) on the row have no curated photos and keep their current ones: ${unmatched.map((r) => String(r.name)).join(", ")}`);
  }
  return { house, rooms, files };
}

function applyPlan(row: Row, plan: Plan): Row {
  const next = clone(row);
  const sub = submissionOf(next);
  sub.housePhotoDataUrls = plan.house;
  for (const room of roomsOf(sub)) {
    const p = plan.rooms.get(String(room.id));
    if (p) room.photoDataUrls = p.urls;
  }
  return next;
}

function printDiff(row: Row, plan: Plan) {
  const sub = submissionOf(row);
  const old = (Array.isArray(sub.housePhotoDataUrls) ? sub.housePhotoDataUrls : []) as string[];
  console.log(`\nrow ${row.id}  address=${JSON.stringify(row.property_data.address ?? null)} title=${JSON.stringify(row.property_data.title ?? null)} status=${String(row.status ?? "")}`);
  console.log(`  cover/house gallery: ${old.length} -> ${plan.house.length} photos (cover = first)`);
  old.forEach((u, i) => console.log(`    - [${i}] ${u}`));
  plan.house.forEach((u, i) => console.log(`    + [${i}] ${u}`));
  for (const r of roomsOf(sub)) {
    const p = plan.rooms.get(String(r.id));
    const o = (Array.isArray(r.photoDataUrls) ? r.photoDataUrls : []) as string[];
    if (!p) {
      console.log(`  room ${String(r.name)} (${String(r.id)}): ${o.length} photos, unchanged (no curated set)`);
      continue;
    }
    console.log(`  room ${String(r.name)} (${String(r.id)}): ${o.length} -> ${p.urls.length}`);
    o.forEach((u) => console.log(`    - ${u}`));
    p.urls.forEach((u) => console.log(`    + ${u}`));
  }
  const photoish = Object.keys(row.property_data).filter((k) => /image|photo|gallery|cover/i.test(k) && k !== "listingSubmission");
  if (photoish.length) console.log(`  NOTE other property_data keys that look photo-related (NOT touched, outside the waiver): ${photoish.join(", ")}`);
  const rowDataSub = (row.row_data as Record<string, Json> | null)?.submission;
  if (rowDataSub) console.log("  NOTE row_data.submission also exists (NOT touched; the waiver names property_data.listingSubmission only)");
  const total = new Set(plan.files.keys()).size;
  console.log(`  files to upload: ${total} unique (house ${plan.house.length} + rooms ${[...plan.rooms.values()].reduce((n, r) => n + r.urls.length, 0)} slots)`);
}

async function urlOk(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: "HEAD" });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function fetchRow(db: SupabaseClient, id: string): Promise<Row> {
  const { data, error } = await db.from(TABLE).select("*").eq("id", id).maybeSingle();
  if (error) fail(`read ${id}: ${error.message}`);
  if (!data) fail(`row ${id} not found`);
  return data as Row;
}

function restoreHint(backupFile: string, ref: string): string {
  return `restore with: npx tsx --env-file=<env> scripts/one-shot/live-listing-photos-20261112.mts --project-ref ${ref} --restore ${backupFile}`;
}

async function writeProperty(db: SupabaseClient, row: Row, property_data: Row["property_data"]) {
  let q = db.from(TABLE).update({ property_data }).eq("id", row.id);
  // Optimistic guard: refuse to overwrite an edit made since we read the row.
  if (typeof row.updated_at === "string") q = q.eq("updated_at", row.updated_at);
  const { data, error } = await q.select("id");
  if (error) fail(`update ${row.id}: ${error.message}`);
  if (!data || data.length !== 1) fail(`update ${row.id} matched ${data?.length ?? 0} rows (the row changed since it was read?)`);
}

async function main() {
  const argv = process.argv.slice(2);
  const projectRef = argValue(argv, "--project-ref");
  const house = argValue(argv, "--house") as HouseKey | undefined;
  const restoreFile = argValue(argv, "--restore");
  const devTestRecord = argValue(argv, "--dev-test-record");
  const apply = argv.includes("--apply");
  const curatedBase = argValue(argv, "--curated-dir") ?? path.join(os.homedir(), ".cockpit/photos-1112/curated");

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (!projectRef) fail("--project-ref is required");
  if (refFromUrl(url) !== projectRef) fail(`--project-ref ${projectRef} does not match the Supabase URL ref (${refFromUrl(url) || "none"})`);
  if (!key) fail("SUPABASE_SERVICE_ROLE_KEY is not set");
  if (devTestRecord && projectRef !== DEV_REF) fail("--dev-test-record only works on the dev project");
  const db = createClient(url, key, { auth: { persistSession: false } });
  const allowedIds = new Set([...WAIVER_IDS, ...(devTestRecord ? [devTestRecord] : [])]);
  const backupDir = path.join(os.homedir(), ".cockpit/backups/live-photos-1112", projectRef === DEV_REF ? "dev-test" : "");

  // ---------------------------------------------------------------- restore
  if (restoreFile) {
    const backup = JSON.parse(fs.readFileSync(restoreFile, "utf8")) as { projectRef: string; row: Row };
    if (backup.projectRef !== projectRef) fail(`backup is from project ${backup.projectRef}, not ${projectRef}`);
    if (!allowedIds.has(backup.row.id)) fail(`backup row ${backup.row.id} is not one of the waiver's three records`);
    const current = await fetchRow(db, backup.row.id);
    const next = clone(current);
    const bSub = submissionOf(backup.row);
    const nSub = submissionOf(next);
    if ("housePhotoDataUrls" in bSub) nSub.housePhotoDataUrls = bSub.housePhotoDataUrls;
    else delete nSub.housePhotoDataUrls;
    for (const room of roomsOf(nSub)) {
      const b = roomsOf(bSub).find((r) => r.id === room.id);
      if (!b) continue;
      if ("photoDataUrls" in b) room.photoDataUrls = b.photoDataUrls;
      else delete room.photoDataUrls;
    }
    await writeProperty(db, current, next.property_data);
    const after = await fetchRow(db, backup.row.id);
    if (canon(maskedRow(after)) !== canon(maskedRow(current))) fail("restore moved a non-photo field; inspect the row immediately");
    const aSub = submissionOf(after);
    if (canon(aSub.housePhotoDataUrls ?? null) !== canon(bSub.housePhotoDataUrls ?? null)) fail("restored house photos differ from the backup");
    for (const b of roomsOf(bSub)) {
      const a = roomsOf(aSub).find((r) => r.id === b.id);
      if (a && canon(a.photoDataUrls ?? null) !== canon(b.photoDataUrls ?? null)) fail(`restored photos of room ${String(b.name)} differ from the backup`);
    }
    console.log(`restored photo fields of ${backup.row.id} from ${restoreFile}; every other field unchanged. OK`);
    return;
  }

  // ------------------------------------------------------------ dry run / apply
  if (!house || !(house in HOUSES)) fail("--house must be one of 5257, 5259, 4709A");
  const targetId = devTestRecord ?? HOUSES[house].id;
  if (!allowedIds.has(targetId)) fail(`refusing record ${targetId}: not one of the waiver's three records`);
  if (!devTestRecord && !WAIVER_IDS.includes(targetId)) fail("record id not in the waiver");
  const curatedDir = path.join(curatedBase, house);
  if (!fs.existsSync(curatedDir)) fail(`curated folder ${curatedDir} not found`);

  const row = await fetchRow(db, targetId);
  const addr = `${String(row.property_data.address ?? "")} ${String(row.property_data.title ?? "")}`;
  if (!devTestRecord && !addr.includes(HOUSES[house].addressToken)) {
    fail(`row ${targetId} reads "${addr.trim()}" which does not contain ${HOUSES[house].addressToken}; the id/house mapping looks wrong, nothing written`);
  }
  const plan = buildPlan(db, row, curatedDir);
  console.log(`${apply ? "APPLY" : "DRY RUN"} project=${projectRef} house=${house}`);
  printDiff(row, plan);

  if (!apply) {
    let present = 0;
    for (const objectPath of plan.files.keys()) if (await urlOk(publicUrl(db, objectPath))) present += 1;
    console.log(`\n${present}/${plan.files.size} files already in the bucket. Dry run: nothing written.`);
    return;
  }

  const marker = path.join(backupDir, `${house}.applied`);
  if (!devTestRecord && fs.existsSync(marker)) fail(`${marker} exists: this house was already applied; the waiver is one apply per house`);

  // 1. backup first
  fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupFile = path.join(backupDir, `${house}-${stamp}.json`);
  fs.writeFileSync(backupFile, JSON.stringify({ projectRef, takenAt: new Date().toISOString(), house, row }, null, 2), { mode: 0o600 });
  const reread = JSON.parse(fs.readFileSync(backupFile, "utf8")) as { row: Row };
  if (canon(reread.row) !== canon(row)) fail(`backup ${backupFile} did not read back identically; nothing changed`);
  console.log(`\nbackup written and verified: ${backupFile}`);

  // 2. upload (skipping what is already there) and prove every URL answers 200 BEFORE the row points at it
  let uploaded = 0;
  for (const [objectPath, f] of plan.files) {
    const u = publicUrl(db, objectPath);
    if (await urlOk(u)) continue;
    const { error } = await db.storage.from(BUCKET).upload(objectPath, fs.readFileSync(f.file), {
      contentType: "image/jpeg",
      cacheControl: "31536000",
      upsert: false,
    });
    if (error && !/exist|duplicate/i.test(error.message)) fail(`upload ${objectPath}: ${error.message}. Row not touched.`);
    uploaded += 1;
  }
  for (const objectPath of plan.files.keys()) {
    if (!(await urlOk(publicUrl(db, objectPath)))) fail(`uploaded object ${objectPath} does not return 200. Row not touched.`);
  }
  console.log(`uploaded ${uploaded} new files; all ${plan.files.size} URLs return 200`);

  // 3. write ONLY the photo fields onto a fresh read of the row
  const fresh = await fetchRow(db, targetId);
  if (canon(fresh) !== canon(row)) fail("the row changed after the backup was taken; nothing written. Re-run (uploads are reusable).");
  const next = applyPlan(fresh, plan);
  await writeProperty(db, fresh, next.property_data);

  // 4. read back and verify
  const after = await fetchRow(db, targetId);
  const problems: string[] = [];
  if (canon(maskedRow(after)) !== canon(maskedRow(row))) problems.push("a non-photo field differs from the backup");
  for (const col of ["manager_user_id", "status", "row_data"] as const) {
    if (canon(after[col]) !== canon(row[col])) problems.push(`column ${col} differs from the backup`);
  }
  const aSub = submissionOf(after);
  if (canon(aSub.housePhotoDataUrls) !== canon(plan.house)) problems.push("housePhotoDataUrls is not the planned list");
  for (const r of roomsOf(aSub)) {
    const p = plan.rooms.get(String(r.id));
    if (p && canon(r.photoDataUrls) !== canon(p.urls)) problems.push(`room ${String(r.name)} photos are not the planned list`);
  }
  const urls = [...(aSub.housePhotoDataUrls as string[]), ...roomsOf(aSub).flatMap((r) => (plan.rooms.has(String(r.id)) ? (r.photoDataUrls as string[]) : []))];
  for (const u of new Set(urls)) if (!(await urlOk(u))) problems.push(`URL does not return 200: ${u}`);
  if (problems.length) {
    console.error(problems.map((p) => `  - ${p}`).join("\n"));
    fail(`read-back verification failed. ${restoreHint(backupFile, projectRef)}`);
  }
  if (!devTestRecord) fs.writeFileSync(marker, `${new Date().toISOString()} ${backupFile}\n`, { mode: 0o600 });
  console.log(`\nverified: only the photo fields changed; ${new Set(urls).size} distinct URLs return 200. Do not re-run.`);
  console.log(restoreHint(backupFile, projectRef));
}

void main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
