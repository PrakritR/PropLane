import "server-only";

import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * The admin data-route gate, re-derived in EVERY admin route: a signed-out
 * caller is 401, a signed-in caller who does not hold the admin role is 403.
 * A route never trusts a prior page-level check or a client-supplied role.
 */
export async function requireAdminRoute(): Promise<
  { ok: true; userId: string } | { ok: false; response: NextResponse }
> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return { ok: false, response: NextResponse.json({ error: "Unauthorized." }, { status: 401 }) };
  }
  if (!(await isAdminUser(user.id))) {
    return { ok: false, response: NextResponse.json({ error: "Forbidden." }, { status: 403 }) };
  }
  return { ok: true, userId: user.id };
}
