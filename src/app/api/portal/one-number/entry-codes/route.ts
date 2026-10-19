import { NextResponse } from "next/server";
import { loadSharedLineConfig, workspaceHasDedicatedNumber } from "@/lib/one-number/config.server";
import {
  ENTRY_CODE_ERROR_STATUS,
  entryCodeErrorMessage,
  presentEntryCode,
} from "@/lib/one-number/entry-codes-api.server";
import { createEntryCode, listEntryCodes, suggestEntryCode } from "@/lib/one-number/entry-codes.server";
import { grantCoversHouse, resolveCommunicationGrant } from "@/lib/one-number/communication-grant.server";
import { propertyInWorkspace, resolveListingChannelContext } from "@/lib/listing-channels/route-context.server";

export const runtime = "nodejs";

/**
 * GET ?propertyId=: this workspace's entry codes for one house, plus the shared number and a suggested code.
 * While the line is per-workspace there is nothing to show: the answer is 404, so the row is simply absent.
 * The workspace comes from the signed-in manager; the property is re-checked against it.
 */
export async function GET(request: Request) {
  const ctx = await resolveListingChannelContext(request).catch(() => null);
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const config = await loadSharedLineConfig(ctx.db);
  if (config.mode === "per_workspace" || !config.sharedNumber || workspaceHasDedicatedNumber(config, ctx.workspace.id)) return NextResponse.json({ error: "Not available." }, { status: 404 });

  // House membership is not a grant: a teammate sees the codes of the houses they hold Communication on.
  const access = await resolveCommunicationGrant(ctx.db, ctx.userId, ctx.workspace, "read");
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  const propertyId = new URL(request.url).searchParams.get("propertyId")?.trim() ?? "";
  if (propertyId && (!grantCoversHouse(access.grant, propertyId) || !(await propertyInWorkspace(ctx.db, ctx.workspace, propertyId)))) {
    return NextResponse.json({ error: "Property not found." }, { status: 404 });
  }
  const held = new Set(ctx.workspace.propertyIds.filter((id) => grantCoversHouse(access.grant, id)));
  const records = (await listEntryCodes(ctx.db, { workspaceId: ctx.workspace.id, propertyId: propertyId || null })).filter((r) => held.has(r.propertyId));
  const suggestion =
    propertyId && records.every((r) => !r.active)
      ? await suggestEntryCode(ctx.db, { workspaceId: ctx.workspace.id, ownerUserId: ctx.workspace.ownerUserId }, propertyId)
      : null;
  return NextResponse.json({
    sharedNumber: config.sharedNumber,
    codes: records.map((r) => presentEntryCode(r, config.sharedNumber)),
    suggestion,
  });
}

/** POST `{ propertyId, code? }`: create a code for one of this workspace's houses (omit `code` to take the suggestion). */
export async function POST(request: Request) {
  let body: { propertyId?: unknown; code?: unknown; workspaceId?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "Invalid request." }, { status: 400 });
  }
  const ctx = await resolveListingChannelContext(request, typeof body.workspaceId === "string" ? body.workspaceId : null).catch(() => null);
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const config = await loadSharedLineConfig(ctx.db);
  if (config.mode === "per_workspace" || !config.sharedNumber || workspaceHasDedicatedNumber(config, ctx.workspace.id)) return NextResponse.json({ error: "Not available." }, { status: 404 });

  const access = await resolveCommunicationGrant(ctx.db, ctx.userId, ctx.workspace, "edit");
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });

  const propertyId = typeof body.propertyId === "string" ? body.propertyId.trim() : "";
  if (!propertyId || !grantCoversHouse(access.grant, propertyId) || !(await propertyInWorkspace(ctx.db, ctx.workspace, propertyId))) {
    return NextResponse.json({ error: "Property not found." }, { status: 404 });
  }
  const created = await createEntryCode(ctx.db, {
    workspaceId: ctx.workspace.id,
    ownerUserId: ctx.workspace.ownerUserId,
    actorUserId: ctx.userId,
    propertyId,
    code: typeof body.code === "string" ? body.code : null,
  });
  if (!created.ok) return NextResponse.json({ error: entryCodeErrorMessage(created.error), reason: created.error }, { status: ENTRY_CODE_ERROR_STATUS[created.error] });
  return NextResponse.json({ code: presentEntryCode(created.record, config.sharedNumber) }, { status: 201 });
}
