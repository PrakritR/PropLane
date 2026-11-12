import "server-only";

import { phoneSignInEnabled } from "@/lib/auth/phone-auth.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

/**
 * Should a signed-out page draw the phone box? One bounded read of `phoneSignInEnabled` (any line mode): an unreadable
 * answer, a thrown error or 1.5 seconds of silence all read as "no", so the page always renders its email / Google
 * methods. The SERVER still decides at `/api/auth/phone/start` (409 off); this only chooses what to draw.
 */
export async function readPhoneSignInPreference(): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const enabled = await Promise.race([
      phoneSignInEnabled(createSupabaseServiceRoleClient()),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), 1500); }),
    ]);
    return enabled === true;
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
