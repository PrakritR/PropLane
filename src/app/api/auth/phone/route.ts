import { createRealIdentitySupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { phoneVerificationEnabled, readPhoneIdentity } from "@/lib/auth/phone-auth.server";
import { phoneAuthFailure, phoneAuthResponse } from "@/lib/auth/phone-auth-request.server";

export const runtime = "nodejs";

export async function GET() {
  try {
    const db = createSupabaseServiceRoleClient();
    const enabled = await phoneVerificationEnabled(db);
    if (!enabled) return phoneAuthResponse({ enabled: false, verified: false, phone: null, needsOldNumber: false });
    const client = await createRealIdentitySupabaseServerClient();
    const { data: { user } } = await client.auth.getUser();
    const identity = user ? await readPhoneIdentity(db, user.id) : { verified: false, phone: null };
    return phoneAuthResponse({ enabled, ...identity, needsOldNumber: identity.verified });
  } catch { return phoneAuthFailure(); }
}
