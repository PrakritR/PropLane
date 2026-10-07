import { NextResponse } from "next/server";
import { resolveVendorPortalUserId } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { isVendorIntegrationProvider } from "@/lib/vendor-integrations";

export const runtime = "nodejs";

const TABLE = "vendor_integration_access_requests";

async function actor() {
  const resolved = await resolveVendorPortalUserId();
  if (!resolved.ok) {
    return { response: NextResponse.json({ ok: false, error: "Unauthorized." }, { status: resolved.status }) };
  }
  return { userId: resolved.userId };
}

function unavailable() {
  return NextResponse.json({ ok: false, error: "Could not send your request." }, { status: 503 });
}

export async function GET() {
  const current = await actor();
  if ("response" in current) return current.response;
  try {
    const { data, error } = await createSupabaseServiceRoleClient()
      .from(TABLE)
      .select("provider")
      .eq("vendor_user_id", current.userId);
    if (error) return unavailable();
    const requested = (data ?? [])
      .map((row) => (row as { provider?: unknown }).provider)
      .filter(isVendorIntegrationProvider);
    return NextResponse.json({ ok: true, requested });
  } catch {
    return unavailable();
  }
}

export async function POST(req: Request) {
  const current = await actor();
  if ("response" in current) return current.response;
  const body = (await req.json().catch(() => null)) as { provider?: unknown } | null;
  const provider = body?.provider;
  if (!isVendorIntegrationProvider(provider)) {
    return NextResponse.json({ ok: false, error: "Unknown provider." }, { status: 400 });
  }
  try {
    const { error } = await createSupabaseServiceRoleClient()
      .from(TABLE)
      .upsert(
        { vendor_user_id: current.userId, provider },
        { onConflict: "vendor_user_id,provider", ignoreDuplicates: true },
      );
    if (error) return unavailable();
    return NextResponse.json({ ok: true, provider });
  } catch {
    return unavailable();
  }
}
