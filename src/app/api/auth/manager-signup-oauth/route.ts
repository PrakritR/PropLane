import { track } from "@/lib/analytics/posthog";
import { completeManagerSignupFromOAuth } from "@/lib/auth/complete-manager-signup";
import { resolveRequestOrigin } from "@/lib/app-url";
import { finalizeManagerGoogleCalendarLink } from "@/lib/google-calendar/link-after-manager-provision.server";
import { resolveManagerPortalEntryPath } from "@/lib/auth/manager-google-services-onboarding.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

type Body = { sessionId: string };

export async function POST(req: Request) {
  try {
    const { sessionId } = (await req.json()) as Body;
    const supabaseAuth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabaseAuth.auth.getUser();
    const {
      data: { session },
    } = await supabaseAuth.auth.getSession();

    if (!user?.id || !user.email || !user.email_confirmed_at) {
      return NextResponse.json({ error: "Sign in with Google first." }, { status: 401 });
    }

    const service = createSupabaseServiceRoleClient();
    const result = await completeManagerSignupFromOAuth(service, user.id, user.email, sessionId);

    if (!result.ok) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    const calendar = await finalizeManagerGoogleCalendarLink(
      service,
      user,
      session,
      resolveRequestOrigin(req),
      { intent: "manager" },
    );

    track("manager_signup_oauth_completed", user.id, { manager_id: result.managerId ?? "" });
    return NextResponse.json({
      ok: true,
      managerId: result.managerId,
      calendarConnected: calendar.connected,
      redirectTo: await resolveManagerPortalEntryPath(service, user.id),
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Signup failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
