import { NextResponse } from "next/server";
import { requireAdminRoute } from "@/lib/admin/admin-route-guard.server";
import { addServiceVendor, listServiceVendors, removeServiceVendor, updateServiceVendor } from "@/lib/service/service-vendors.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * Admin > Service > Vendors: the PropLane Service vendor roster (one list for every service workspace).
 * Every verb starts with `requireAdminRoute()` (401 signed out, 403 not an admin); the roster layer then re-derives
 * the service owner and only touches rows that owner owns AND flagged as roster. A body id is a name, not a grant.
 */
export async function GET() {
  const admin = await requireAdminRoute();
  if (!admin.ok) return admin.response;
  const result = await listServiceVendors(createSupabaseServiceRoleClient());
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status, headers: NO_STORE });
  return NextResponse.json({ configured: result.configured, vendors: result.vendors }, { headers: NO_STORE });
}

export async function POST(request: Request) {
  const admin = await requireAdminRoute();
  if (!admin.ok) return admin.response;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400, headers: NO_STORE });
  }
  const result = await addServiceVendor(createSupabaseServiceRoleClient(), admin.userId, body);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status, headers: NO_STORE });
  return NextResponse.json({ vendor: result.vendor, intro: result.intro }, { status: 201, headers: NO_STORE });
}

export async function PATCH(request: Request) {
  const admin = await requireAdminRoute();
  if (!admin.ok) return admin.response;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const id = typeof body?.id === "string" ? body.id : "";
  if (!body || !id.trim()) return NextResponse.json({ error: "Invalid request." }, { status: 400, headers: NO_STORE });
  const result = await updateServiceVendor(createSupabaseServiceRoleClient(), admin.userId, id, body);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status, headers: NO_STORE });
  return NextResponse.json({ vendor: result.vendor, intro: result.intro }, { headers: NO_STORE });
}

export async function DELETE(request: Request) {
  const admin = await requireAdminRoute();
  if (!admin.ok) return admin.response;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const id = typeof body?.id === "string" ? body.id : "";
  if (!id.trim()) return NextResponse.json({ error: "Invalid request." }, { status: 400, headers: NO_STORE });
  const result = await removeServiceVendor(createSupabaseServiceRoleClient(), admin.userId, id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status, headers: NO_STORE });
  return NextResponse.json({ ok: true }, { headers: NO_STORE });
}
