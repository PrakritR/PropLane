import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { canSendResidentWelcome } from "@/lib/resident-welcome.server";
import { sendBookingResidentInvite } from "@/lib/booking-resident-invite.server";
import { managerScheduleRecordIdOwnedByUser, ROOM_DATE_BLOCK_RECORD_TYPE } from "@/lib/portal-schedule-record-scope";

export const runtime = "nodejs";

type Body = {
  blockId?: unknown;
  propertyId?: unknown;
  propertyLabel?: unknown;
  residentName?: unknown;
  residentEmail?: unknown;
  residentPhone?: unknown;
};

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/**
 * "Add booking" with a new resident: mints/attaches a resident identity and
 * sends the account-setup + move-in link, by SMS from the workspace's work
 * number when a phone is on file, else by email
 * (docs/agents/sms-system.md; src/lib/booking-resident-invite.server.ts).
 */
export async function POST(req: Request) {
  try {
    const auth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await auth.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const blockId = str(body.blockId);
    const propertyId = str(body.propertyId);
    if (!blockId || !propertyId) {
      return NextResponse.json({ error: "blockId and propertyId are required." }, { status: 400 });
    }
    if (!managerScheduleRecordIdOwnedByUser(blockId, user.id, ROOM_DATE_BLOCK_RECORD_TYPE)) {
      return NextResponse.json({ error: "That booking is not yours." }, { status: 403 });
    }

    const svc = createSupabaseServiceRoleClient();
    const { data: requestor } = await svc.from("profiles").select("role, full_name").eq("id", user.id).maybeSingle();
    if (!canSendResidentWelcome(requestor?.role)) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    const result = await sendBookingResidentInvite(
      svc,
      { userId: user.id, email: user.email ?? null, managerName: String(requestor?.full_name ?? "") },
      {
        blockId,
        propertyId,
        propertyLabel: str(body.propertyLabel),
        residentName: str(body.residentName),
        residentEmail: str(body.residentEmail),
        residentPhone: str(body.residentPhone),
      },
    );

    if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 400 });

    // Stamp the booking record itself once the invite has actually gone out
    // — a merge, never a blind overwrite, so the dates/resident fields the
    // block was just saved with survive. Cosmetic only: the resident's own
    // unlock comes from the `manager_application_records` row tagged in
    // `sendBookingResidentInvite`, not from this flag.
    const { data: existingBlock } = await svc
      .from("portal_schedule_records")
      .select("row_data")
      .eq("id", blockId)
      .eq("manager_user_id", user.id)
      .maybeSingle();
    const existingRowData =
      existingBlock?.row_data && typeof existingBlock.row_data === "object"
        ? (existingBlock.row_data as Record<string, unknown>)
        : {};
    await svc
      .from("portal_schedule_records")
      .update({ row_data: { ...existingRowData, isBookingResidency: true } })
      .eq("id", blockId)
      .eq("manager_user_id", user.id);

    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not send the invite." },
      { status: 500 },
    );
  }
}
