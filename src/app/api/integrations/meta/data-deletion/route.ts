import { NextResponse } from "next/server";

import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { mintDeletionConfirmationCode, verifyMetaSignedRequest } from "@/lib/listing-channels/meta/data-deletion";
import { deleteMetaDataForProviderUser } from "@/lib/listing-channels/meta/connection.server";
import { metaAppCredentials } from "@/lib/listing-channels/meta/graph.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/**
 * Meta's required data-deletion callback. Anonymous by design: the HMAC `signed_request` is the
 * credential. Deletes that Meta user's stored tokens and the posting rows they produced, then
 * answers `{ url, confirmation_code }` for Meta to show the person.
 */
export async function POST(request: Request) {
  const creds = metaAppCredentials();
  if (!creds) return NextResponse.json({ error: "Not configured." }, { status: 503 });

  const form = await request.formData().catch(() => null);
  const signedRequest = typeof form?.get("signed_request") === "string" ? (form.get("signed_request") as string) : null;
  const parsed = verifyMetaSignedRequest(signedRequest, creds.appSecret);
  if (!parsed) return NextResponse.json({ error: "Invalid signed_request." }, { status: 400 });

  try {
    await deleteMetaDataForProviderUser(createSupabaseServiceRoleClient(), parsed.user_id);
  } catch {
    return NextResponse.json({ error: "Deletion failed. Meta will retry." }, { status: 500 });
  }
  const code = mintDeletionConfirmationCode(parsed.user_id, creds.appSecret);
  return NextResponse.json({
    url: `${resolveEmailLinkBaseUrl().replace(/\/$/, "")}/integrations/meta/data-deletion?code=${encodeURIComponent(code)}`,
    confirmation_code: code,
  });
}
