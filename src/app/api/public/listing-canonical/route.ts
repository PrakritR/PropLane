import { NextResponse } from "next/server";

import { resolveListingParam } from "@/lib/listing-slug";
import { getListingSlugIndex } from "@/lib/seo/listing-slugs.server";

export const revalidate = 3600;

/**
 * `GET /api/public/listing-canonical?param=<what followed /rent/listings/>` -> `{ slug }` when that param is a record id or a
 * stale slug (the middleware 308s to `slug`), `{ slug: null }` otherwise. Public catalog facts only; CDN-cached, so the
 * middleware's lookup costs one read per param per hour.
 */
export async function GET(request: Request) {
  const param = (new URL(request.url).searchParams.get("param") ?? "").trim().slice(0, 300);
  let slug: string | null = null;
  if (param) {
    const resolution = resolveListingParam(await getListingSlugIndex(), param);
    if (resolution.kind === "redirect") slug = resolution.slug;
  }
  return NextResponse.json({ slug }, { headers: { "Cache-Control": "public, s-maxage=3600, stale-while-revalidate=86400" } });
}
