import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { parseGuestDraftRequest, stashGuestApplicationDraft } from "@/lib/rental-application/guest-draft.server";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const HOUR_MS = 60 * 60 * 1000;
const NO_STORE = { "Cache-Control": "no-store" };
export const GUEST_DRAFTS_PER_IP_PER_HOUR = 10;
export const GUEST_DRAFTS_PER_CONTACT_PER_HOUR = 5;
const MAX_BODY_CHARS = 300 * 1024;

const contactKey = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);

/**
 * Hold a guest's finished application until a phone or mailbox is proven (captain, Nov 14: apply with no account).
 *
 *   POST { propertyId, form }  ->  { ok, token, expiresAt }
 *
 * Nothing here creates an account, an application row or anything the manager sees: it only stores the draft under an
 * unguessable token (its SHA-256 at rest, 24 hours). The home is re-derived from the database. Proof and the claim come
 * after, through the phone sign-in door or the emailed `token_hash` link, and the draft is submitted by the resident
 * through the ordinary signed-in write.
 */
export async function POST(req: Request) {
  if (!(await rateLimit(`guest-draft-ip:${clientIpFrom(req)}`, GUEST_DRAFTS_PER_IP_PER_HOUR, HOUR_MS)).ok) {
    return NextResponse.json({ error: "Too many tries. Please try again later." }, { status: 429, headers: NO_STORE });
  }
  const raw = await req.text().catch(() => "");
  if (!raw || raw.length > MAX_BODY_CHARS) return NextResponse.json({ error: "A draft is required." }, { status: 400, headers: NO_STORE });
  let body: unknown = null;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "A draft is required." }, { status: 400, headers: NO_STORE });
  }
  const parsed = parseGuestDraftRequest(body);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400, headers: NO_STORE });

  const { email, phoneE164 } = parsed.value;
  for (const key of [`guest-draft-email:${contactKey(email)}`, ...(phoneE164 ? [`guest-draft-phone:${contactKey(phoneE164)}`] : [])]) {
    if (!(await rateLimit(key, GUEST_DRAFTS_PER_CONTACT_PER_HOUR, HOUR_MS)).ok) {
      return NextResponse.json({ error: "Too many tries. Please try again later." }, { status: 429, headers: NO_STORE });
    }
  }

  const stashed = await stashGuestApplicationDraft(createSupabaseServiceRoleClient(), parsed.value);
  if (!stashed.ok) return NextResponse.json({ error: stashed.error }, { status: stashed.status, headers: NO_STORE });
  return NextResponse.json({ ok: true, token: stashed.token, expiresAt: stashed.expiresAt }, { headers: NO_STORE });
}
