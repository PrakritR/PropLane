import { userHoldsManagerRole } from "@/lib/manager-route-guard.server";
import "server-only";

import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

/** The signed-in manager for a Bookings route, or null. The user id comes from the session only. */
export async function requireBookingsManager() {
  const supabaseAuth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabaseAuth.auth.getUser();
  if (!user?.id) return null;

  const db = createSupabaseServiceRoleClient();
  if (!(await userHoldsManagerRole(db, user.id))) return null;
  return { db, userId: user.id };
}
