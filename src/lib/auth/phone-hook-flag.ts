/**
 * The hosted Supabase Send SMS hook is opt-in: `SUPABASE_PHONE_AUTH_HOOK_ENABLED=1` (the older
 * spelling `true` is read the same). Anything else, including unset, means the hook sends nothing
 * off the shared line and sign-in never asks Supabase to text.
 */
export function phoneAuthHookEnabled(): boolean {
  const flag = process.env.SUPABASE_PHONE_AUTH_HOOK_ENABLED?.trim();
  return flag === "1" || flag === "true";
}
