import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { cookies } from "next/headers";
import { supabaseAuthCookieOptions } from "@/lib/supabase/cookie-options";
import { assertNonProdDatabase } from "@/lib/server-env";
import { VIEW_AS_COOKIE } from "@/lib/auth/view-as-token";
import { resolveViewAsIdentity, type ActiveViewAs } from "@/lib/auth/view-as.server";

/**
 * Marker on the synthetic user a view-as session produces, so server code that
 * must read the viewed account's rows with the service role (RLS would answer
 * for the operator, not the viewed account) can tell it apart from a real
 * sign-in. See `view-as.server.ts`.
 */
export type ViewAsAuthUser = User & { __viewAs: ActiveViewAs };

export function isViewAsAuthUser(user: unknown): user is ViewAsAuthUser {
  return Boolean(user && typeof user === "object" && "__viewAs" in (user as Record<string, unknown>));
}

function syntheticViewAsUser(real: User, session: ActiveViewAs): ViewAsAuthUser {
  return {
    ...real,
    id: session.targetUserId,
    email: session.target.email ?? undefined,
    phone: undefined,
    user_metadata: {},
    app_metadata: {},
    identities: [],
    __viewAs: session,
  };
}

/**
 * The server client with NO identity substitution: `auth.getUser()` answers
 * with whoever is really signed in. Only the code that must know the REAL
 * operator uses this (starting/ending a view-as session, verifying one).
 * Everything else goes through {@link createSupabaseServerClient}.
 */
export async function createRealIdentitySupabaseServerClient(): Promise<SupabaseClient> {
  assertNonProdDatabase();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anon) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY");
  }

  const cookieStore = await cookies();

  return createServerClient(url, anon, {
    cookieOptions: supabaseAuthCookieOptions({ secure: process.env.NODE_ENV === "production" }),
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          /* ignore when called from a Server Component that cannot set cookies */
        }
      },
    },
  });
}

async function hasViewAsCookie(): Promise<boolean> {
  try {
    return Boolean((await cookies()).get(VIEW_AS_COOKIE)?.value);
  } catch {
    return false;
  }
}

/**
 * The request's Supabase server client. While a verified "View as" session is
 * active (signed cookie, same operator, still allowlisted admin, 30 minutes),
 * `auth.getUser()` and `auth.getClaims()` answer with the VIEWED account, so
 * every route that resolves its caller this way and then reads with the service
 * role shows that account's data. Without a session the client is untouched.
 *
 * Writes never reach a route while viewing (the middleware refuses every
 * non-read request), so the substituted identity is only ever used to READ.
 * Reads made through this client's own session (RLS) still run as the real
 * operator; a route that relies on RLS for a read therefore shows the
 * operator's rows, never the viewed account's.
 */
export async function createSupabaseServerClient() {
  const client = await createRealIdentitySupabaseServerClient();
  if (!(await hasViewAsCookie())) return client;

  const auth = client.auth;
  const realGetUser = auth.getUser.bind(auth);
  const realGetClaims = auth.getClaims.bind(auth);

  auth.getUser = (async (jwt?: string) => {
    const result = await realGetUser(jwt);
    if (jwt || result.error || !result.data?.user) return result;
    const session = await resolveViewAsIdentity(result.data.user.id);
    if (!session) return result;
    return { data: { user: syntheticViewAsUser(result.data.user, session) }, error: null };
  }) as typeof auth.getUser;

  auth.getClaims = (async (...args: Parameters<typeof realGetClaims>) => {
    const result = await realGetClaims(...args);
    const claims = result.data?.claims;
    if (args[0] || result.error || !claims || typeof claims.sub !== "string") return result;
    const session = await resolveViewAsIdentity(claims.sub);
    if (!session) return result;
    return {
      data: {
        ...result.data!,
        claims: { ...claims, sub: session.targetUserId, email: session.target.email ?? undefined },
      },
      error: null,
    };
  }) as typeof auth.getClaims;

  return client;
}
