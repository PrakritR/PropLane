import { NextResponse } from "next/server";
import { resolveVendorPortalUserId } from "@/lib/auth/vendor-api-access";
import {
  getVendorWorkIdentity,
  setupVendorWorkIdentity,
} from "@/lib/vendor-work-identity.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

function invalid(message: string) {
  return NextResponse.json({ ok: false, error: message }, { status: 400 });
}

async function actor() {
  const resolved = await resolveVendorPortalUserId();
  if (!resolved.ok) return { response: NextResponse.json({ ok: false, error: "Unauthorized." }, { status: resolved.status }) };
  return { userId: resolved.userId };
}

export async function GET() {
  const current = await actor();
  if ("response" in current) return current.response;
  try {
    return NextResponse.json({ ok: true, identity: await getVendorWorkIdentity(createSupabaseServiceRoleClient(), current.userId) });
  } catch {
    return NextResponse.json({ ok: false, error: "Work identity is temporarily unavailable." }, { status: 503 });
  }
}

export async function POST(req: Request) {
  const current = await actor();
  if ("response" in current) return current.response;
  const body = await req.json().catch(() => null) as { channel?: unknown; idempotencyKey?: unknown } | null;
  const channel = typeof body?.channel === "string" ? body.channel : "";
  const idempotencyKey = typeof body?.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  if (channel !== "email" && channel !== "sms") return invalid("channel must be email or sms.");
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(idempotencyKey)) return invalid("A UUID idempotencyKey is required.");
  try {
    // The lifecycle currently reconciles the requested channel through the
    // provider adapter; its runtime gates prevent a dev request from buying a
    // number or sending mail when provider configuration is absent.
    const identity = await setupVendorWorkIdentity(createSupabaseServiceRoleClient(), current.userId, idempotencyKey, channel);
    return NextResponse.json({ ok: true, identity });
  } catch {
    return NextResponse.json({ ok: false, error: "Work identity setup could not be started." }, { status: 503 });
  }
}
