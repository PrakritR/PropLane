import { NextResponse } from "next/server";
import { loadSharedLineConfig, workspaceHasDedicatedNumber } from "@/lib/one-number/config.server";
import { setEntryCodeActive } from "@/lib/one-number/entry-codes.server";
import { resolveListingChannelContext } from "@/lib/listing-channels/route-context.server";
import { grantCoversHouse, resolveCommunicationGrant } from "@/lib/one-number/communication-grant.server";
import { entryCodeErrorMessage, presentEntryCode } from "@/lib/one-number/entry-codes-api.server";

export const runtime = "nodejs";

/**
 * PATCH `{ active: boolean }`: turn one of THIS workspace's codes on or off. The workspace is the signed-in
 * manager's; a code that belongs to another workspace answers 404, the same as a code that does not exist.
 */
export async function PATCH(request: Request, context: { params: Promise<{ code: string }> }) {
  const { code: rawCode } = await context.params;
  let code: string;
  try {
    code = decodeURIComponent(rawCode);
  } catch {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }
  let body: { active?: unknown; workspaceId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  if (typeof body.active !== "boolean") return NextResponse.json({ error: "active must be true or false." }, { status: 400 });
  const ctx = await resolveListingChannelContext(request, typeof body.workspaceId === "string" ? body.workspaceId : null).catch(() => null);
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const config = await loadSharedLineConfig(ctx.db);
  if (config.mode === "per_workspace" || !config.sharedNumber || workspaceHasDedicatedNumber(config, ctx.workspace.id)) return NextResponse.json({ error: "Not available." }, { status: 404 });

  const access = await resolveCommunicationGrant(ctx.db, ctx.userId, ctx.workspace, "edit");
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
  const allowedPropertyIds = ctx.workspace.propertyIds.filter((id) => grantCoversHouse(access.grant, id));

  const result = await setEntryCodeActive(ctx.db, { workspaceId: ctx.workspace.id, code, active: body.active, allowedPropertyIds });
  if (!result.ok) {
    const status = result.error === "not_found" ? 404 : result.error === "too_many" ? 409 : 503;
    return NextResponse.json({ error: entryCodeErrorMessage(result.error), reason: result.error }, { status });
  }
  return NextResponse.json({ code: presentEntryCode(result.record, config.sharedNumber) });
}
