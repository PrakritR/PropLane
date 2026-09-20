import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { actorWorkspaceStanding } from "@/lib/workspaces/membership.server";
import { normalizeE164 } from "@/lib/twilio";
import { resolveManagerWorkNumber } from "@/lib/twilio-provisioning";
import { sendFromManagerWorkNumber } from "@/lib/proplane-sms-transport.server";

export const runtime = "nodejs";

/**
 * Text a workspace invite to a phone with no PropLane account yet — the
 * invite link itself carries the grant, this route only delivers it. Same
 * authorization gate as minting or reading the link (`rights.members`), and
 * the same work-number transport `record-share-link/send` and
 * `send-lead-invite` already use for an ad hoc phone recipient, so this
 * inherits their consent + quiet-hours + work-number gating rather than
 * inventing a second one.
 */
export async function POST(req: Request) {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  const body = (await req.json().catch(() => ({}))) as {
    workspaceId?: string;
    phone?: string;
    text?: string;
  };
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const phone = normalizeE164(String(body.phone ?? "").trim());
  if (!workspaceId) return NextResponse.json({ error: "workspaceId is required." }, { status: 400 });
  if (!phone) return NextResponse.json({ error: "Enter a valid phone number." }, { status: 400 });
  if (!text) return NextResponse.json({ error: "Nothing to send." }, { status: 400 });

  const db = createSupabaseServiceRoleClient();
  const standing = await actorWorkspaceStanding(db, user.id, workspaceId);
  if (!standing) return NextResponse.json({ error: "That workspace is not yours to invite into." }, { status: 403 });
  if (!standing.rights.members) {
    return NextResponse.json(
      { error: "Only the workspace owner or an admin can invite into this workspace." },
      { status: 403 },
    );
  }

  const workNumber = await resolveManagerWorkNumber(db, user.id);
  if (!workNumber) {
    return NextResponse.json(
      { error: "No work number on this account yet. Finish SMS setup under Communication first." },
      { status: 400 },
    );
  }

  const result = await sendFromManagerWorkNumber({
    managerUserId: user.id,
    to: phone,
    text,
    fromNumber: workNumber,
    source: "work_number",
    counterpartyRole: "manager",
  });
  if (!result.ok) {
    return NextResponse.json(
      {
        error:
          result.error === "recipient_opted_out"
            ? "That number has opted out of texts."
            : "Could not send the text.",
      },
      { status: 502 },
    );
  }
  return NextResponse.json({ ok: true });
}
