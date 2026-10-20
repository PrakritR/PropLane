import { NextResponse } from "next/server";
import { requireAdminRoute } from "@/lib/admin/admin-route-guard.server";
import {
  clearServiceManagerPhone,
  readServiceManagerView,
  requestServiceManagerPhoneCode,
  verifyServiceManagerPhone,
} from "@/lib/service/service-manager.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const NO_STORE = { "Cache-Control": "private, no-store" };

/**
 * Admin > Service settings > Manager phone. The phone that acts as the service manager (alerts go to it; a text from it
 * to the PropLane line is the manager of every service workspace). Every verb starts with `requireAdminRoute()`.
 * `send-code` texts a six-digit code to the number being verified; `verify` checks it and saves the phone; `clear`
 * removes it. Each change is audited before it applies.
 */
export async function GET() {
  const admin = await requireAdminRoute();
  if (!admin.ok) return admin.response;
  return NextResponse.json(await readServiceManagerView(createSupabaseServiceRoleClient()), { headers: NO_STORE });
}

export async function POST(request: Request) {
  const admin = await requireAdminRoute();
  if (!admin.ok) return admin.response;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid request." }, { status: 400, headers: NO_STORE });
  }
  const db = createSupabaseServiceRoleClient();
  switch (body.action) {
    case "send-code": {
      const result = await requestServiceManagerPhoneCode(db, admin.userId, body.phone);
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status, headers: NO_STORE });
      return NextResponse.json({ ok: true }, { headers: NO_STORE });
    }
    case "verify": {
      const result = await verifyServiceManagerPhone(db, admin.userId, { phone: body.phone, code: body.code });
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status, headers: NO_STORE });
      return NextResponse.json(result.view, { headers: NO_STORE });
    }
    case "clear": {
      const result = await clearServiceManagerPhone(db, admin.userId);
      if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status, headers: NO_STORE });
      return NextResponse.json(result.view, { headers: NO_STORE });
    }
    default:
      return NextResponse.json({ error: "Unknown action." }, { status: 400, headers: NO_STORE });
  }
}
