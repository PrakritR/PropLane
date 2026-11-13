/**
 * FCRA adverse action for an application with a Checkr consumer report. A manager who is about to decline answers
 * "Is this decision based in whole or part on the background check?" here:
 *
 *   action=decide   { basedOnReport: boolean }  NO records the answer; YES sends the PRE-ADVERSE notice and starts the
 *                   five-business-day wait. An answer is required: a missing/non-boolean value is refused.
 *   action=finalize                             sends the FINAL notice once the wait has passed.
 *   action=cancel                               withdraws a pending pre-adverse notice.
 *
 * Every call re-derives the application and the caller's authority (owner, admin, or a co-manager with `applications`
 * edit) from storage. The decline itself is still the normal application write; `adverseActionDeclineBlocker` refuses
 * it on the server until the answer is on record. GET reads the state for the screen.
 */
import { NextResponse } from "next/server";

import { resolveAppOrigin } from "@/lib/app-url";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import {
  adverseActionStatusFor,
  cancelAdverseAction,
  decideAdverseAction,
  finalizeAdverseAction,
  loadAdverseActionApplication,
  loadLatestAdverseAction,
} from "@/lib/screening/adverse-action.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

type Body = {
  applicationId?: unknown;
  action?: unknown;
  basedOnReport?: unknown;
  kind?: unknown;
};

async function sessionUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

export async function GET(req: Request) {
  try {
    const user = await sessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const applicationId = new URL(req.url).searchParams.get("applicationId")?.trim();
    if (!applicationId) return NextResponse.json({ error: "applicationId is required." }, { status: 400 });
    const db = createSupabaseServiceRoleClient();
    const access = await loadAdverseActionApplication(db, user, applicationId, "read");
    if (!access.ok) return NextResponse.json({ error: access.error }, { status: access.status });
    const latest = await loadLatestAdverseAction(db, access.applicationId);
    if (latest.error) return NextResponse.json({ error: "Adverse-action state is unavailable." }, { status: 503 });
    return NextResponse.json(
      { status: adverseActionStatusFor(access.row, latest.facts) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ error: "Adverse-action state is unavailable." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const user = await sessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    if (!(await rateLimit(`adverse-action:${user.id}:${clientIpFrom(req)}`, 20, 60_000)).ok) {
      return NextResponse.json({ error: "Too many requests. Please slow down." }, { status: 429 });
    }
    const body = (await req.json().catch(() => ({}))) as Body;
    const applicationId = typeof body.applicationId === "string" ? body.applicationId.trim() : "";
    if (!applicationId) return NextResponse.json({ error: "applicationId is required." }, { status: 400 });
    const db = createSupabaseServiceRoleClient();
    const origin = resolveAppOrigin(req);

    let result;
    if (body.action === "decide") {
      // The answer is the point: "based on the report?" must be an explicit yes or no, never defaulted.
      if (typeof body.basedOnReport !== "boolean") {
        return NextResponse.json(
          { error: "Answer whether this decision is based on the background check.", code: "answer_required" },
          { status: 400 },
        );
      }
      result = await decideAdverseAction(db, {
        user,
        applicationId,
        basedOnReport: body.basedOnReport,
        kind: body.kind === "condition" ? "condition" : "decline",
        origin,
      });
    } else if (body.action === "finalize") {
      result = await finalizeAdverseAction(db, { user, applicationId, origin });
    } else if (body.action === "cancel") {
      result = await cancelAdverseAction(db, { user, applicationId });
    } else {
      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
    }

    if (!result.ok) {
      return NextResponse.json(
        { error: result.error, ...(result.code ? { code: result.code } : {}), ...("adverse" in result && result.adverse ? { status: result.adverse } : {}) },
        { status: result.status },
      );
    }
    return NextResponse.json({ ok: true, status: result.status });
  } catch {
    return NextResponse.json({ error: "Adverse action could not be processed." }, { status: 500 });
  }
}
