import { NextResponse } from "next/server";
import { readServiceFeeSplitForViewer } from "@/lib/owner-management/service-fee-split.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * The fee split of one PropLane Service workspace, for Settings > Balance & payouts. The viewer is the session; the
 * workspace id in the query is a name, never a grant: `readServiceFeeSplitForViewer` re-derives that the workspace is a
 * service workspace and that the viewer is an admin, its owner or a seat of it, and derives `canEdit` itself.
 */
export async function GET(request: Request) {
  const session = await createSupabaseServerClient();
  const {
    data: { user },
  } = await session.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401, headers: NO_STORE });
  const workspaceId = new URL(request.url).searchParams.get("workspaceId") ?? "";
  const result = await readServiceFeeSplitForViewer(createSupabaseServiceRoleClient(), user.id, workspaceId);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status, headers: NO_STORE });
  return NextResponse.json(result.view, { headers: NO_STORE });
}
