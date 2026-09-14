import { NextResponse } from "next/server";
import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { loadHouseRecord, managerMayPrintHouse } from "@/lib/house-printables/load.server";
import {
  buildHousePublicUrl,
  ensureHousePublicLink,
  findHousePublicLink,
  revokeHousePublicLinks,
} from "@/lib/house-printables/public-link.server";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";

export const runtime = "nodejs";

/**
 * The public QR link for a house. GET reads it, POST issues (or reuses) it,
 * DELETE revokes it — after which every poster carrying it opens "This page is
 * no longer available" until the manager reprints.
 */
async function authorize(propertyId: string | null | undefined) {
  const ctx = await requireManagerRouteUser();
  if (!ctx) return { error: NextResponse.json({ error: "Unauthorized." }, { status: 401 }) };
  const id = propertyId?.trim();
  if (!id) return { error: NextResponse.json({ error: "propertyId required." }, { status: 400 }) };
  const house = await loadHouseRecord(ctx.db, id);
  if (!house || !(await managerMayPrintHouse(ctx.db, ctx.userId, house.ownerUserId))) {
    return { error: NextResponse.json({ error: "Not found." }, { status: 404 }) };
  }
  return { ctx, house };
}

function missingTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return message.includes("manager_house_public_links") || message.toLowerCase().includes("schema cache");
}

function failure(error: unknown, fallback: string): NextResponse {
  if (missingTable(error)) {
    return NextResponse.json(
      { error: "Printables need a database update: apply the manager_house_public_links migration." },
      { status: 503 },
    );
  }
  console.error("[house-public-link]", error);
  return NextResponse.json({ error: fallback }, { status: 500 });
}

export async function GET(req: Request) {
  const auth = await authorize(new URL(req.url).searchParams.get("propertyId"));
  if ("error" in auth) return auth.error;
  try {
    const link = await findHousePublicLink(auth.ctx.db, auth.house.ownerUserId, auth.house.propertyId);
    return NextResponse.json({
      url: link ? buildHousePublicUrl(resolveEmailLinkBaseUrl(), link.token) : null,
      issuedAt: link?.createdAt ?? null,
    });
  } catch (error) {
    return failure(error, "Could not read the house link.");
  }
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { propertyId?: string };
  const auth = await authorize(body.propertyId);
  if ("error" in auth) return auth.error;
  try {
    const link = await ensureHousePublicLink(auth.ctx.db, auth.house.ownerUserId, auth.house.propertyId);
    return NextResponse.json({
      url: buildHousePublicUrl(resolveEmailLinkBaseUrl(), link.token),
      issuedAt: link.createdAt,
    });
  } catch (error) {
    return failure(error, "Could not issue the house link.");
  }
}

export async function DELETE(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { propertyId?: string };
  const auth = await authorize(body.propertyId);
  if ("error" in auth) return auth.error;
  try {
    const revoked = await revokeHousePublicLinks(auth.ctx.db, auth.house.ownerUserId, auth.house.propertyId);
    return NextResponse.json({ revoked });
  } catch (error) {
    return failure(error, "Could not revoke the house link.");
  }
}
