import { NextResponse } from "next/server";

import { allowedPhotoHosts, isAllowedPhotoUrl } from "@/lib/listing-channels/photo-hosts";
import { listingPostPhotoUrls } from "@/lib/listing-channels/post-text";
import { propertyInWorkspace, resolveListingChannelContext } from "@/lib/listing-channels/route-context.server";
import { loadSyncListing } from "@/lib/listing-channels/sync.server";
import { buildStoreZip, type ZipEntry } from "@/lib/zip-store";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_PHOTOS = 20;
const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 8_000;
/** Inside `maxDuration`: past this the zip ships with whatever was fetched rather than being killed. */
const FETCH_DEADLINE_MS = 40_000;

function slugify(value: string): string {
  const slug = value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return slug || "listing";
}

/**
 * One photo, read through a size-capped stream: the cap is enforced chunk by chunk, so a response
 * that declares no `Content-Length` can never buffer more than `cap` bytes. `cap` is also what is
 * left of the whole-zip budget, which keeps peak memory at `MAX_TOTAL_BYTES`, not
 * `MAX_PHOTOS * MAX_PHOTO_BYTES`.
 */
async function fetchPhoto(url: string, cap: number, timeoutMs: number): Promise<Uint8Array | null> {
  if (cap <= 0 || timeoutMs <= 0) return null;
  try {
    const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok || !res.body) return null;
    const declared = Number(res.headers.get("content-length") ?? "0");
    if (Number.isFinite(declared) && declared > cap) {
      await res.body.cancel().catch(() => {});
      return null;
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      size += value.byteLength;
      if (size > cap) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const chunk of chunks) {
      out.set(chunk, at);
      at += chunk.byteLength;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * GET ?propertyId=: the listing's public photos as one zip, for sites with no photo-URL import.
 * Same auth as the other listing-channels read routes - any member of the workspace the listing
 * belongs to, who already sees these photos in the portal. A listing outside the signed-in
 * manager's workspace is a 404, never a 403. Only the write routes are owner-gated.
 */
export async function GET(request: Request) {
  const ctx = await resolveListingChannelContext(request).catch(() => null);
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const propertyId = new URL(request.url).searchParams.get("propertyId")?.trim() || "";
  if (!propertyId) return NextResponse.json({ error: "propertyId is required." }, { status: 400 });

  const owned = await propertyInWorkspace(ctx.db, ctx.workspace, propertyId);
  if (!owned) return NextResponse.json({ error: "Property not found." }, { status: 404 });
  const listing = await loadSyncListing(ctx.db, propertyId);
  if (!listing) return NextResponse.json({ error: "Property not found." }, { status: 404 });

  const hosts = allowedPhotoHosts();
  const allowed = listingPostPhotoUrls(listing.projected).filter((u) => isAllowedPhotoUrl(u, hosts));
  const urls = allowed.slice(0, MAX_PHOTOS);
  if (urls.length === 0) return NextResponse.json({ error: "This listing has no photos to download." }, { status: 404 });

  // Sequential on purpose: one photo is in memory at a time and the loop stops at the total cap,
  // so this never buffers every photo at once. It also stops at the deadline, so a slow host
  // costs the manager the last photos rather than the whole download.
  const entries: ZipEntry[] = [];
  const deadline = Date.now() + FETCH_DEADLINE_MS;
  let total = 0;
  for (const [index, url] of urls.entries()) {
    const remaining = MAX_TOTAL_BYTES - total;
    if (remaining <= 0) break;
    const timeLeft = deadline - Date.now();
    if (timeLeft <= 0) break;
    const data = await fetchPhoto(url, Math.min(MAX_PHOTO_BYTES, remaining), Math.min(FETCH_TIMEOUT_MS, timeLeft));
    if (!data) continue;
    total += data.length;
    const match = /\.(jpe?g|png|webp|gif|heic)$/i.exec(new URL(url).pathname);
    const ext = match ? match[1]!.toLowerCase().replace("jpeg", "jpg") : "jpg";
    // Numbered by the listing's own photo order, so a photo that was skipped leaves a visible gap.
    entries.push({ name: `photo-${String(index + 1).padStart(2, "0")}.${ext}`, data });
  }
  if (entries.length === 0) return NextResponse.json({ error: "Could not fetch this listing's photos." }, { status: 502 });

  // A zip short of the listing's photos says so in its name and a header: 2 of 12 photos must
  // never look like a complete 2-photo listing, or the manager posts an under-photographed ad.
  const partial = entries.length < allowed.length;
  const zip = buildStoreZip(entries);
  return new NextResponse(zip as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(zip.length),
      "Content-Disposition": `attachment; filename="${slugify(listing.projected.title || propertyId)}-photos${partial ? "-partial" : ""}.zip"`,
      "Cache-Control": "private, no-store",
      ...(partial ? { "X-Photos-Partial": `${entries.length}/${allowed.length}` } : {}),
    },
  });
}
