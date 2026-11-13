/**
 * The applicant's copy of the consumer report named in a pre-adverse or final adverse-action notice. Authenticated
 * (never a Checkr URL, never a public link): the signed-in applicant who owns the application, and only once the
 * manager has recorded that the decision is based on that report. Streams the PDF; nothing is stored.
 */
import { NextResponse } from "next/server";

import type { DemoApplicantRow } from "@/data/demo-portal";
import { clientIpFrom, rateLimit } from "@/lib/rate-limit";
import { loadCheckReportPdf } from "@/lib/checkr/report-pdf.server";
import { loadLatestAdverseAction } from "@/lib/screening/adverse-action.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

export async function GET(req: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Sign in to open your report." }, { status: 401 });
    if (!(await rateLimit(`adverse-action-report:${user.id}:${clientIpFrom(req)}`, 20, 60_000)).ok) {
      return NextResponse.json({ error: "Too many requests. Please slow down." }, { status: 429 });
    }
    const applicationId = new URL(req.url).searchParams.get("applicationId")?.trim();
    if (!applicationId) return NextResponse.json({ error: "applicationId is required." }, { status: 400 });

    const db = createSupabaseServiceRoleClient();
    const { data: record, error } = await db
      .from("manager_application_records")
      .select("id, resident_email, row_data")
      .eq("id", applicationId)
      .maybeSingle();
    if (error) return NextResponse.json({ error: "Report unavailable." }, { status: 503 });
    const row = (record?.row_data as DemoApplicantRow | null) ?? null;
    const email = user.email?.trim().toLowerCase() ?? "";
    const ownsByEmail = Boolean(email) && String(record?.resident_email ?? "").trim().toLowerCase() === email;
    const ownsBySubject = Boolean(row?.residentUserId) && row?.residentUserId === user.id;
    // The applicant's own application: the bound Auth subject, or (while unbound) the confirmed session mailbox.
    if (!record || !row || !(ownsBySubject || (!row.residentUserId && ownsByEmail))) {
      return NextResponse.json({ error: "Application not found." }, { status: 404 });
    }

    const check = row.backgroundCheck;
    const latest = await loadLatestAdverseAction(db, String(record.id));
    if (latest.error) return NextResponse.json({ error: "Report unavailable." }, { status: 503 });
    const facts = latest.facts;
    if (
      !check ||
      check.status !== "complete" ||
      !facts ||
      !facts.basedOnReport ||
      facts.reportId !== check.reportId ||
      (facts.stage !== "pre_adverse_sent" && facts.stage !== "finalized")
    ) {
      return NextResponse.json({ error: "No report copy is available for this application." }, { status: 404 });
    }

    const pdf = await loadCheckReportPdf(check);
    if (!pdf) return NextResponse.json({ error: "Could not retrieve the report. Try again shortly." }, { status: 502 });
    return new NextResponse(pdf, {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="consumer-report-${String(record.id)}.pdf"`,
        "Cache-Control": "private, no-store",
      },
    });
  } catch {
    return NextResponse.json({ error: "Report unavailable." }, { status: 500 });
  }
}
