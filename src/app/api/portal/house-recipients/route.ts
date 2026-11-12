import { NextResponse } from "next/server";
import { grantCoversHouse, resolveCommunicationGrant } from "@/lib/one-number/communication-grant.server";
import { propertyInWorkspace, resolveListingChannelContext } from "@/lib/listing-channels/route-context.server";
import { loadHouseMessageRecipients } from "@/lib/house-message-recipients.server";
import { pacificDayKey } from "@/lib/house-groups/time";

export const runtime = "nodejs";

/**
 * The people a "everyone living there" message reaches, for the New message sheet's tally.
 * The workspace comes from the signed-in manager and the house is re-checked against it plus the viewer's
 * Communication grant: a property id in the query is a name, never authorization. Channel short-stay guests
 * are left out unless `includeGuests=1`. Sending is NOT here: each person is sent to through
 * `/api/portal/send-inbox-message`, which authorizes every recipient again.
 */
export async function GET(request: Request) {
  const ctx = await resolveListingChannelContext(request).catch(() => null);
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const url = new URL(request.url);
  const propertyId = url.searchParams.get("propertyId")?.trim() ?? "";
  const includeGuests = url.searchParams.get("includeGuests") === "1";

  const access = await resolveCommunicationGrant(ctx.db, ctx.userId, ctx.workspace, "edit");
  if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
  if (!propertyId || !grantCoversHouse(access.grant, propertyId)) {
    return NextResponse.json({ error: "Property not found." }, { status: 404 });
  }
  if (!(await propertyInWorkspace(ctx.db, ctx.workspace, propertyId))) {
    return NextResponse.json({ error: "Property not found." }, { status: 404 });
  }

  try {
    const result = await loadHouseMessageRecipients(ctx.db, {
      ownerUserId: ctx.workspace.ownerUserId,
      propertyId,
      today: pacificDayKey(new Date()),
      includeGuests,
    });
    return NextResponse.json(
      { propertyId, includeGuests, ...result },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch {
    return NextResponse.json({ error: "Could not load who lives there." }, { status: 500 });
  }
}
