import { cookies } from "next/headers";
import { readViewAsSecret, VIEW_AS_COOKIE, verifyViewAsToken } from "@/lib/auth/view-as-token";

/**
 * Dependency-light half of the "View as" read-only guarantee, safe to import from
 * the service-role client factory (no Supabase, no audit, no allowlist: those
 * live in `view-as.server.ts`, which imports the service client).
 *
 * "Open" means: this request carries a validly signed, unexpired view-as cookie.
 * It is deliberately NOT tied to who is signed in. It answers the conservative
 * question "must this request stay a pure read?", and the answer to a doubtful
 * cookie is still "yes": the cookie can only ever make a request MORE
 * restricted, never grant anything.
 */
export async function isViewAsSessionOpen(): Promise<boolean> {
  try {
    const raw = (await cookies()).get(VIEW_AS_COOKIE)?.value?.trim();
    if (!raw) return false;
    return (await verifyViewAsToken(raw, readViewAsSecret())) !== null;
  } catch {
    // Outside a request (cron, webhook, background work): no cookie, no session.
    return false;
  }
}

/** The error a blocked write resolves with: shaped like a Supabase error so callers' `if (error)` paths handle it. */
export const VIEW_AS_WRITE_BLOCKED_ERROR = {
  message: "read_only_view_as",
  details: "A View as session is read-only.",
  hint: "End the View as session to make changes.",
  code: "VIEWAS",
  name: "PostgrestError",
} as const;

/** Tables a view-as session may still append to: its own audit trail. */
export const VIEW_AS_WRITABLE_TABLES: ReadonlySet<string> = new Set(["audit_log"]);
