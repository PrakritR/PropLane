import type { SupabaseClient, User } from "@supabase/supabase-js";

import { withAuthTimeout } from "@/lib/auth/with-timeout";

const DEFAULT_MAX_WAIT_MS = 8_000;
const PER_ATTEMPT_TIMEOUT_MS = 2_500;
const RETRY_DELAY_MS = 200;

/** After native OAuth, cookies may land a tick after navigation — poll before giving up. */
export async function waitForOAuthUser(
  supabase: SupabaseClient,
  options?: { attempts?: number; delayMs?: number; maxWaitMs?: number },
): Promise<User | null> {
  const maxWaitMs = options?.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
  const delayMs = options?.delayMs ?? RETRY_DELAY_MS;
  const deadline = Date.now() + maxWaitMs;

  while (Date.now() < deadline) {
    try {
      const {
        data: { user },
      } = await withAuthTimeout(supabase.auth.getUser(), PER_ATTEMPT_TIMEOUT_MS);
      if (user) return user;
    } catch {
      /* retry until the wall-clock budget expires */
    }
    if (Date.now() + delayMs >= deadline) break;
    await new Promise((resolve) => globalThis.setTimeout(resolve, delayMs));
  }

  return null;
}
