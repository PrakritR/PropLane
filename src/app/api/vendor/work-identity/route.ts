import { NextResponse } from "next/server";
import { resolveVendorPortalUserId } from "@/lib/auth/vendor-api-access";
import {
  getVendorWorkIdentity,
  setupVendorWorkIdentity,
} from "@/lib/vendor-work-identity.server";

/** Loose E.164-ish check — the exact number came from our own search moments earlier. */
const PHONE_NUMBER_RE = /^\+?[1-9]\d{9,14}$/;
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
  const body = await req.json().catch(() => null) as { channel?: unknown; idempotencyKey?: unknown; phoneNumber?: unknown } | null;
  const channel = typeof body?.channel === "string" ? body.channel : "";
  const idempotencyKey = typeof body?.idempotencyKey === "string" ? body.idempotencyKey.trim() : "";
  if (channel !== "email" && channel !== "sms") return invalid("channel must be email or sms.");
  if (!/^[0-9a-f]{8}-[0-9a-f-]{27,36}$/i.test(idempotencyKey)) return invalid("A UUID idempotencyKey is required.");
  // Only SMS ever takes a selected number (from a prior candidates search) — an
  // email claim never accepts client-chosen identity, so a stray field there is
  // simply ignored rather than rejected.
  let selectedPhoneNumber: string | undefined;
  if (channel === "sms" && typeof body?.phoneNumber === "string" && body.phoneNumber.trim()) {
    const candidate = body.phoneNumber.trim();
    if (!PHONE_NUMBER_RE.test(candidate)) return invalid("phoneNumber must be a valid number.");
    selectedPhoneNumber = candidate;
  }
  try {
    // The lifecycle currently reconciles the requested channel through the
    // provider adapter; its runtime gates prevent a dev request from buying a
    // number or sending mail when provider configuration is absent.
    const identity = await setupVendorWorkIdentity(
      createSupabaseServiceRoleClient(),
      current.userId,
      idempotencyKey,
      channel,
      undefined,
      selectedPhoneNumber,
    );
    return NextResponse.json({ ok: true, identity });
  } catch {
    return NextResponse.json({ ok: false, error: "Work identity setup could not be started." }, { status: 503 });
  }
}
