import { NextResponse, type NextRequest } from "next/server";
import { resolveWorkspaceBrowseListings } from "@/lib/workspace-browse.server";
import { WORKSPACE_BROWSE_LIST_PARAM } from "@/lib/workspace-browse-links";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const slug = request.nextUrl.searchParams.get("slug")?.trim() ?? "";
  const list = request.nextUrl.searchParams.get(WORKSPACE_BROWSE_LIST_PARAM);
  const result = await resolveWorkspaceBrowseListings(slug, list);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json(
    { propertyIds: result.propertyIds, workspaceName: result.workspaceName },
    { headers: { "Cache-Control": "public, s-maxage=60, stale-while-revalidate=120" } },
  );
}
