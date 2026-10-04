import { NextResponse } from "next/server";
import {
  listLinkedFormRequestsForApplication,
  listLinkedFormRequestsForResident,
  loadApplicationAccessRow,
  userOwnsApplication,
} from "@/lib/application-linked-form-requests.server";
import { managerCanAccessApplicationRecord } from "@/lib/auth/manager-application-access";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

const NOT_FOUND = { error: "Not found." } as const;

/**
 * Linked forms the signed-in person can see. Never returns a token or its hash.
 *
 *  - `?applicationId=` : the forms owed on one application. A manager of that application gets all of them; its
 *    applicant gets their own. Anyone else gets the same answer as for an application that does not exist.
 *  - no query         : the signed-in resident's own forms ("Forms to finish") and the ones they were linked to
 *    through a share link ("Forms for <applicant>").
 */
export async function GET(req: Request) {
  try {
    const auth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await auth.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const db = createSupabaseServiceRoleClient();
    const applicationId = new URL(req.url).searchParams.get("applicationId")?.trim() ?? "";

    if (!applicationId) {
      const lists = await listLinkedFormRequestsForResident(db, { id: user.id, email: user.email });
      return NextResponse.json(lists, { headers: { "Cache-Control": "private, no-store" } });
    }

    const app = await loadApplicationAccessRow(db, applicationId);
    if (!app) return NextResponse.json(NOT_FOUND, { status: 404 });
    if (await managerCanAccessApplicationRecord(db, user.id, app)) {
      const requests = await listLinkedFormRequestsForApplication(db, app, "manager");
      return NextResponse.json({ requests }, { headers: { "Cache-Control": "private, no-store" } });
    }
    if (userOwnsApplication(app, { id: user.id, email: user.email })) {
      const requests = await listLinkedFormRequestsForApplication(db, app, "applicant");
      return NextResponse.json({ requests }, { headers: { "Cache-Control": "private, no-store" } });
    }
    return NextResponse.json(NOT_FOUND, { status: 404 });
  } catch {
    return NextResponse.json({ error: "Could not load forms." }, { status: 500 });
  }
}
