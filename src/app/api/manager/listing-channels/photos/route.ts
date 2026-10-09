import { NextResponse } from "next/server";

import { allowedPhotoHosts, isAllowedPhotoUrl } from "@/lib/listing-channels/photo-hosts";
import { listingPostPhotoUrls } from "@/lib/listing-channels/post-text";
import { propertyInWorkspace, resolveListingChannelContext } from "@/lib/listing-channels/route-context.server";
import { loadSyncListing } from "@/lib/listing-channels/sync.server";
import { buildStoreZip, type ZipEntry } from "@/lib/zip-store";

export const runtime = "nodejs";

const MAX_PHOTOS = 20;
const MAX_PHOTO_BYTES = 15 * 1024 * 1024;
const MAX_TOTAL_BYTES = 100 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 20_000;

function slugify(value: string): string {
  const slug = value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return slug || "listing";
}

async function fetchPhoto(url: string): Promise<Uint8Array | null> {
  try {
    const res = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    if (Number(res.headers.get("content-length") ?? "0") > MAX_PHOTO_BYTES) return null;
    const buf = new Uint8Array(await res.arrayBuffer());
    return buf.length > MAX_PHOTO_BYTES ? null : buf;
  } catch {
    return null;
  }
}

/**
 * GET ?propertyId=: the listing's public photos as one zip, for sites with no photo-URL import.
 * Same auth as the other listing-channels routes; a listing outside the signed-in manager's
 * workspace is a 404, never a 403.
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
  const urls = listingPostPhotoUrls(listing.projected).filter((u) => isAllowedPhotoUrl(u, hosts)).slice(0, MAX_PHOTOS);
  if (urls.length === 0) return NextResponse.json({ error: "This listing has no photos to download." }, { status: 404 });

  const fetched = await Promise.all(urls.map(fetchPhoto));
  const entries: ZipEntry[] = [];
  let total = 0;
  fetched.forEach((data, index) => {
    if (!data || total + data.length > MAX_TOTAL_BYTES) return;
    total += data.length;
    const match = /\.(jpe?g|png|webp|gif|heic)$/i.exec(new URL(urls[index]!).pathname);
    const ext = match ? match[1]!.toLowerCase().replace("jpeg", "jpg") : "jpg";
    entries.push({ name: `photo-${String(entries.length + 1).padStart(2, "0")}.${ext}`, data });
  });
  if (entries.length === 0) return NextResponse.json({ error: "Could not fetch this listing's photos." }, { status: 502 });

  const zip = buildStoreZip(entries);
  return new NextResponse(zip as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Length": String(zip.length),
      "Content-Disposition": `attachment; filename="${slugify(listing.projected.title || propertyId)}-photos.zip"`,
      "Cache-Control": "private, no-store",
    },
  });
}
