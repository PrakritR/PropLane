import { assertBrowserDatabaseTarget } from "@/lib/supabase/browser-target";
import { createBrowserClient } from "@supabase/ssr";
import { registerBrowserAuthRecovery } from "@/lib/supabase/safe-browser-session";

let supabaseBrowserClient: ReturnType<typeof createBrowserClient> | null = null;

export function createSupabaseBrowserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }
  if (typeof window !== "undefined") assertBrowserDatabaseTarget(url, window.location.hostname);
  supabaseBrowserClient ??= createBrowserClient(url, anon, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
    },
  });
  registerBrowserAuthRecovery(supabaseBrowserClient);
  return supabaseBrowserClient;
}
