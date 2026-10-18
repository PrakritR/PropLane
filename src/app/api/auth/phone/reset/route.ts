import { createRealIdentitySupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { isViewAsSessionOpen } from "@/lib/auth/view-as-guard";
import { assertPhoneRequestOrigin, phoneAuthFailure, phoneAuthResponse } from "@/lib/auth/phone-auth-request.server";
import { resetWorkspaceMemberPhone } from "@/lib/auth/phone-auth-reset.server";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    assertPhoneRequestOrigin(req);
    if (await isViewAsSessionOpen()) return phoneAuthFailure();
    const client = await createRealIdentitySupabaseServerClient();
    const { data: { user }, error } = await client.auth.getUser();
    if (error || !user) return phoneAuthFailure();
    const body = await req.json() as { targetUserId?: unknown };
    if (typeof body.targetUserId !== "string") return phoneAuthFailure();
    await resetWorkspaceMemberPhone(createSupabaseServiceRoleClient(), user.id, body.targetUserId.trim());
    return phoneAuthResponse({ ok: true });
  } catch { return phoneAuthFailure(); }
}
