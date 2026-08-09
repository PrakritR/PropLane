import { NextResponse } from "next/server";

import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import { revokeApiKey } from "@/lib/mcp/api-keys.server";
import { track } from "@/lib/analytics/posthog";

export const runtime = "nodejs";

/** Revoke takes effect on the next request — `findLiveApiKey` re-reads the row. */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await requireManagerRouteUser();
  if (!actor) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const { id } = await ctx.params;
  // revokeApiKey scopes on user_id too, so another manager's key id is a 404.
  const revoked = await revokeApiKey(actor.db, actor.userId, id);
  if (!revoked) return NextResponse.json({ error: "Key not found." }, { status: 404 });

  track("api_key_revoked", actor.userId, {});
  return NextResponse.json({ ok: true });
}
