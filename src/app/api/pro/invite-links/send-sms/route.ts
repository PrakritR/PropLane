import { NextResponse } from "next/server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { actorWorkspaceStanding, workspaceHouseIds } from "@/lib/workspaces/membership.server";
import { memberReachLabel } from "@/lib/workspaces/membership";
import { revealInviteLinkToken } from "@/lib/invite-links/invite-links.server";
import { inviteLinkUrl } from "@/lib/invite-links/invite-link-model";
import { formatInviteMessageBody } from "@/lib/invite-message-body";
import { TEAM_ROLE_LABELS } from "@/lib/co-manager-team-roles";
import { resolveAppOrigin } from "@/lib/app-url";
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
 *
 * The body is composed HERE from the link and the workspace, never relayed
 * from the client: a workspace admin is not a licence to send arbitrary text
 * from a PropLane-owned number. The client names the link (`linkId`); the
 * server re-reads it, proves it belongs to this workspace, and renders the
 * same `formatInviteMessageBody` the sheet previews.
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
    linkId?: string;
  };
  const workspaceId = typeof body.workspaceId === "string" ? body.workspaceId.trim() : "";
  const linkId = typeof body.linkId === "string" ? body.linkId.trim() : "";
  const phone = normalizeE164(String(body.phone ?? "").trim());
  if (!workspaceId) return NextResponse.json({ error: "workspaceId is required." }, { status: 400 });
  if (!linkId) return NextResponse.json({ error: "linkId is required." }, { status: 400 });
  if (!phone) return NextResponse.json({ error: "Enter a valid phone number." }, { status: 400 });

  const db = createSupabaseServiceRoleClient();
  const standing = await actorWorkspaceStanding(db, user.id, workspaceId);
  if (!standing) return NextResponse.json({ error: "That workspace is not yours to invite into." }, { status: 403 });
  if (!standing.rights.members) {
    return NextResponse.json(
      { error: "Only the workspace owner or an admin can invite into this workspace." },
      { status: 403 },
    );
  }

  const reveal = await revealInviteLinkToken(db, { actorUserId: user.id, linkId });
  if (!reveal.ok) return NextResponse.json({ error: reveal.error }, { status: reveal.status });
  const { data: linkRow } = await db
    .from("manager_invite_links")
    .select("owner_user_id, workspace_id, property_labels")
    .eq("id", reveal.link.id)
    .maybeSingle();
  if (
    reveal.link.kind !== "manager" ||
    String(linkRow?.owner_user_id ?? "").trim() !== standing.ownerUserId ||
    String(linkRow?.workspace_id ?? "").trim() !== standing.workspaceId
  ) {
    return NextResponse.json({ error: "That invite link does not belong to this workspace." }, { status: 403 });
  }

  const workNumber = await resolveManagerWorkNumber(db, user.id);
  if (!workNumber) {
    return NextResponse.json(
      { error: "No work number on this account yet. Finish SMS setup under Communication first." },
      { status: 400 },
    );
  }

  const { data: inviterProfile } = await db.from("profiles").select("full_name, email").eq("id", user.id).maybeSingle();
  const inviterName = String(inviterProfile?.full_name ?? "").trim() || String(inviterProfile?.email ?? "").trim();
  const houseScope = reveal.link.houseScope ?? "selected";
  const workspaceHouseCount = (await workspaceHouseIds(db, standing.ownerUserId, standing.workspaceId)).length;
  const propertyLabels = Array.isArray(linkRow?.property_labels)
    ? (linkRow.property_labels as unknown[]).map((label) => String(label ?? "").trim()).filter(Boolean)
    : [];
  const roleLabel = reveal.link.teamRole ? TEAM_ROLE_LABELS[reveal.link.teamRole] : "";
  const reach =
    houseScope === "all"
      ? `All houses in ${standing.workspaceName}`
      : memberReachLabel({
          houseScope: "selected",
          houseCount: reveal.link.assignedPropertyIds.length,
          workspaceHouseCount,
        });

  const text = formatInviteMessageBody({
    kind: "workspace",
    inviterName,
    workspaceName: standing.workspaceName,
    propertyLabels,
    inviteUrl: inviteLinkUrl(resolveAppOrigin(req), reveal.token),
    roleLabel,
    reach,
  });

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
