import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { getUserOrRejection } from "@/lib/auth/session-rejection";
import { getPortalAccessContext, hasRole } from "@/lib/auth/portal-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { suggestManagerTimeForKind, type ManagerSuggestKind } from "@/lib/manager-schedule-suggest.server";

export const runtime = "nodejs";

const JSON_HEADERS = { "Cache-Control": "no-store" };

function isManagerSuggestKind(value: string | null): value is ManagerSuggestKind {
  return value === "services" || value === "tasks";
}

/**
 * A time suggestion for the services/tasks scheduling flows — never tours,
 * which have their own public booking grid. `managerUserId` is always the
 * authenticated caller: a query param naming another manager would let one
 * account read another's calendar.
 */
export async function GET(req: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    // The 401 body stays generic — telling a caller WHY their session was
    // refused is an oracle. The reason goes to the server log.
    const { user } = await getUserOrRejection(supabase, "GET /api/portal-schedule-suggest");
    if (!user) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401, headers: JSON_HEADERS });
    }

    const access = await getPortalAccessContext();
    if (!hasRole(access, "manager")) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401, headers: JSON_HEADERS });
    }

    const url = new URL(req.url);
    const kindRaw = url.searchParams.get("kind");
    if (!isManagerSuggestKind(kindRaw)) {
      return NextResponse.json({ error: 'kind must be "services" or "tasks".' }, { status: 400, headers: JSON_HEADERS });
    }

    let durationMinutes: number | undefined;
    const durationRaw = url.searchParams.get("duration");
    if (durationRaw !== null) {
      const parsed = Number(durationRaw);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        return NextResponse.json({ error: "duration must be a positive number of minutes." }, { status: 400, headers: JSON_HEADERS });
      }
      durationMinutes = parsed;
    }

    const seed = url.searchParams.get("seed")?.trim() ?? "";
    if (!seed) {
      return NextResponse.json({ error: "seed is required." }, { status: 400, headers: JSON_HEADERS });
    }
    const after = url.searchParams.get("after")?.trim() || undefined;
    const excludeWorkOrderId = url.searchParams.get("excludeWorkOrderId")?.trim() || undefined;

    const db = createSupabaseServiceRoleClient();
    const suggestion = await suggestManagerTimeForKind(db, user.id, {
      kind: kindRaw,
      durationMinutes,
      seed,
      after,
      excludeWorkOrderId,
    });

    return NextResponse.json({ suggestion }, { headers: JSON_HEADERS });
  } catch {
    return NextResponse.json({ error: "Could not load a suggestion." }, { status: 500, headers: JSON_HEADERS });
  }
}
