import { NextResponse } from "next/server";
import { resolveAppOrigin } from "@/lib/app-url";
import { isCommunicationDeepPath, signInThenPath } from "@/lib/communication/deep-links";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { resolveActiveWorkspace } from "@/lib/workspaces/active.server";
import { WORKSPACE_COOKIE } from "@/lib/workspaces/types";

export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ASK = /^[a-z]{3,16}:[A-Za-z0-9][A-Za-z0-9:_.@+-]{0,199}$/;

/**
 * The door a notice's thread link goes through when the conversation lives in a specific workspace (a PropLane-managed
 * one the staff member may not have selected): `/open/thread?w=<workspace>&p=<communication path>[&ask=<kind:id>]`.
 *
 * It is a name, never authorization. `p` must be one role's Communication path (`isCommunicationDeepPath`); `w` is
 * selected only when `resolveActiveWorkspace` confirms the viewer can already see it (a workspace they cannot see is
 * ignored, exactly as the cookie is); the destination then re-checks the conversation and shows the normal not-found
 * to anyone it is not for. A signed-out open goes through sign-in and comes back here.
 */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const path = url.searchParams.get("p")?.trim() ?? "";
  const workspaceId = url.searchParams.get("w")?.trim() ?? "";
  const ask = url.searchParams.get("ask")?.trim() ?? "";
  const origin = resolveAppOrigin(request);
  if (!isCommunicationDeepPath(path)) return NextResponse.redirect(new URL("/auth/continue", origin));
  const destination = ask && ASK.test(ask) ? `${path}?ask=${encodeURIComponent(ask)}` : path;

  const auth = await createSupabaseServerClient();
  const {
    data: { user },
  } = await auth.auth.getUser();
  if (!user) {
    const back = `${url.pathname}${url.search}`;
    return NextResponse.redirect(new URL(signInThenPath(back), origin));
  }
  const res = NextResponse.redirect(new URL(destination, origin));
  if (UUID.test(workspaceId) && path.startsWith("/portal/")) {
    try {
      const active = await resolveActiveWorkspace(createSupabaseServiceRoleClient(), user.id, workspaceId);
      if (active.id.toLowerCase() === workspaceId.toLowerCase()) {
        res.cookies.set(WORKSPACE_COOKIE, active.id, {
          httpOnly: true,
          sameSite: "lax",
          path: "/",
          secure: process.env.NODE_ENV === "production",
          maxAge: 60 * 60 * 24 * 365,
        });
      }
    } catch {
      /* the viewer's own selection stands */
    }
  }
  return res;
}
