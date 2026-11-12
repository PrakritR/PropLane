import { NextResponse } from "next/server";
import { requireManagerRouteUser } from "@/lib/manager-route-guard.server";
import { loadOnboardingStatus } from "@/lib/resident-onboarding-link/status.server";

export const runtime = "nodejs";

/**
 * GET ?applicationId= : how far one manager-added resident has got (link sent, opened, account, lease, first payment).
 * The record is re-read in the caller's own scope; the id is a name, never a grant.
 */
export async function GET(request: Request) {
  const auth = await requireManagerRouteUser({ fast: true });
  if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const applicationId = (new URL(request.url).searchParams.get("applicationId") ?? "").trim();
  if (!applicationId || applicationId.length > 160) return NextResponse.json({ error: "Name a resident." }, { status: 400 });
  const result = await loadOnboardingStatus(auth.db, { userId: auth.userId, applicationId });
  if (!result.ok) {
    return result.reason === "not_found"
      ? NextResponse.json({ error: "Resident not found." }, { status: 404 })
      : NextResponse.json({ error: "Could not read the resident. Try again." }, { status: 503 });
  }
  return NextResponse.json(
    { applicationId: result.applicationId, name: result.name, hasPhone: result.hasPhone, hasEmail: result.hasEmail, steps: result.progress.steps, emailSentAt: result.progress.emailSentAt, textSentAt: result.progress.textSentAt },
    { headers: { "Cache-Control": "no-store" } },
  );
}
