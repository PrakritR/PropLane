import "server-only";

import { cookies } from "next/headers";
import type { SupabaseClient, User } from "@supabase/supabase-js";

/**
 * Why a session was rejected — the thing a bare 401 does not tell you.
 *
 * A rejected session used to return `401 {"error":"Unauthorized."}` and write
 * nothing anywhere. Expired, malformed, wrong project, clock skew, cookie never
 * sent: all identical from the outside. Establishing which one it was (PRP-259)
 * took minting a token by hand in Node and presenting the same cookie to two
 * servers to prove the application code was fine and a peer's checkout was not.
 * One line at the rejection point answers it in seconds.
 *
 * The token is NEVER logged. It is a live credential, and a log is the last
 * place it should be durable. Only the shape of the failure is recorded.
 */
export type AuthRejectionReason =
  | "no-cookie"
  | "unreadable-cookie"
  | "expired"
  | "rejected-by-supabase"
  | "no-user";

export type AuthRejection = {
  reason: AuthRejectionReason;
  /** Supabase's own message, when it gave one. Never contains the token. */
  detail?: string;
  /** Whether an auth cookie was present at all, and roughly how big. */
  cookie: { present: boolean; chunked: boolean; bytes: number };
};

/** The `sb-<project-ref>-auth-token` family, without needing the ref. */
function authCookieState(all: { name: string; value: string }[]): AuthRejection["cookie"] {
  const parts = all.filter((c) => /^sb-.*-auth-token(\.\d+)?$/.test(c.name));
  return {
    present: parts.length > 0,
    // @supabase/ssr splits a large session across `.0` / `.1`. An UNCHUNKED
    // cookie near the ~4096-byte browser limit is worth seeing in the log: any
    // growth in claims crosses it, and a silently dropped cookie looks exactly
    // like a rejected one.
    chunked: parts.some((c) => /\.\d+$/.test(c.name)),
    bytes: parts.reduce((sum, c) => sum + c.value.length, 0),
  };
}

function classify(message: string | undefined, cookie: AuthRejection["cookie"]): AuthRejectionReason {
  const text = (message ?? "").toLowerCase();
  if (!cookie.present) return "no-cookie";
  if (text.includes("expired")) return "expired";
  if (text.includes("malformed") || text.includes("invalid jwt") || text.includes("parse")) {
    return "unreadable-cookie";
  }
  if (text) return "rejected-by-supabase";
  return "no-user";
}

/**
 * `getUser()`, plus the reason when there is no user.
 *
 * Callers keep answering 401 exactly as before — the reason is for the server
 * log, never the response body, because telling a caller *why* their session
 * was refused is an oracle.
 */
export async function getUserOrRejection(
  supabase: SupabaseClient,
  where: string,
): Promise<{ user: User | null; rejection?: AuthRejection }> {
  const { data, error } = await supabase.auth.getUser();
  if (data?.user) return { user: data.user };

  let all: { name: string; value: string }[] = [];
  try {
    all = (await cookies()).getAll().map((c) => ({ name: c.name, value: c.value }));
  } catch {
    /* not in a request scope — leave the cookie state unknown-but-absent */
  }
  const cookie = authCookieState(all);
  const rejection: AuthRejection = {
    reason: classify(error?.message, cookie),
    detail: error?.message,
    cookie,
  };
  console.warn(
    `[auth] session rejected at ${where}: ${rejection.reason}` +
      ` (cookie ${cookie.present ? `present, ${cookie.bytes}B${cookie.chunked ? ", chunked" : ", unchunked"}` : "absent"})` +
      (rejection.detail ? ` — ${rejection.detail}` : ""),
  );
  return { user: null, rejection };
}

/**
 * Log a rejection when the caller already has the error in hand and does not
 * need the user back. Same rules: reason and cookie shape only, never the token.
 */
export async function describeAuthRejection(
  error: { message?: string } | null | undefined,
  where: string,
): Promise<AuthRejection> {
  let all: { name: string; value: string }[] = [];
  try {
    all = (await cookies()).getAll().map((c) => ({ name: c.name, value: c.value }));
  } catch {
    /* not in a request scope */
  }
  const cookie = authCookieState(all);
  const rejection: AuthRejection = {
    reason: classify(error?.message, cookie),
    detail: error?.message,
    cookie,
  };
  console.warn(
    `[auth] session rejected at ${where}: ${rejection.reason}` +
      ` (cookie ${cookie.present ? `present, ${cookie.bytes}B${cookie.chunked ? ", chunked" : ", unchunked"}` : "absent"})` +
      (rejection.detail ? ` — ${rejection.detail}` : ""),
  );
  return rejection;
}
