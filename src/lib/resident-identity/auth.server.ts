import { authorizeResidentRole } from "@/lib/auth/resident-role-access";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export async function residentIdentityActor() {
  const auth = await createSupabaseServerClient();
  const { data: { user } } = await auth.auth.getUser();
  if (!user) return null;
  const db = createSupabaseServiceRoleClient();
  const { data: profile, error } = await db.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (error || !(await authorizeResidentRole(db, { userId: user.id, legacyRole: profile?.role }))) return null;
  return { db, userId: user.id };
}
