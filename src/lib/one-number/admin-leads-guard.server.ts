import "server-only";

import { isAdminUser } from "@/lib/auth/admin-preview";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/** The platform admin behind this request, or null. The Unassigned-leads queue has no other reader. */
export async function requirePlatformAdmin(): Promise<{ userId: string } | { status: 401 | 403 }> {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { status: 401 };
  if (!(await isAdminUser(user.id))) return { status: 403 };
  return { userId: user.id };
}
