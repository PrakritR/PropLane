import { NextResponse } from "next/server";
import { getPersonaInquiryStatus, personaEnabled, verifyPersonaSignature } from "@/lib/resident-identity/persona.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";
export async function POST(req: Request) {
  if (!personaEnabled()) return NextResponse.json({ error: "Unavailable." }, { status: 503 });
  const raw = await req.text();
  if (!verifyPersonaSignature(raw, req.headers.get("persona-signature"), process.env.PERSONA_WEBHOOK_SECRET ?? "")) return NextResponse.json({ error: "Invalid signature." }, { status: 401 });
  let payload: { data?: { id?: string; attributes?: { name?: string; "created-at"?: string; payload?: { data?: { id?: string; type?: string; attributes?: { "reference-id"?: string } } } } } };
  try { payload = JSON.parse(raw); } catch { return NextResponse.json({ error: "Invalid event." }, { status: 400 }); }
  const event = payload.data;
  const attributes = event?.attributes;
  const inquiry = attributes?.payload?.data;
  const userId = inquiry?.attributes?.["reference-id"];
  const createdAt = attributes?.["created-at"];
  if (!event?.id || !attributes?.name || !createdAt || !Number.isFinite(Date.parse(createdAt)) || inquiry?.type !== "inquiry" || !inquiry.id || !userId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userId)) return NextResponse.json({ error: "Invalid event." }, { status: 400 });
  let providerStatus: string;
  try { providerStatus = await getPersonaInquiryStatus(inquiry.id, userId); }
  catch { return NextResponse.json({ error: "Provider status unavailable." }, { status: 503 }); }
  const { data, error } = await createSupabaseServiceRoleClient().rpc("apply_resident_identity_event", {
    p_event_id: event.id, p_inquiry_id: inquiry.id, p_reference_id: userId, p_event_type: attributes.name, p_created_at: createdAt, p_provider_status: providerStatus,
  });
  if (error || data === "unknown_inquiry") return NextResponse.json({ error: "Event not yet reconciled." }, { status: 503 });
  return NextResponse.json({ ok: true });
}
