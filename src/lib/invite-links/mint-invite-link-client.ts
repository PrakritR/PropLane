export type MintInviteLinkClientInput = {
  kind?: "manager" | "vendor" | "resident";
  label?: string;
  workspaceId?: string | null;
  assignedPropertyIds: string[];
  propertyPermissions?: unknown;
  propertyLabelsById?: Record<string, string>;
  expiry?: string;
  uses?: string;
  teamRole?: string;
};

export type MintInviteLinkClientResult =
  | { ok: true; url: string; linkId: string }
  | { ok: false; error: string };

export async function mintInviteLinkClient(
  input: MintInviteLinkClientInput,
): Promise<MintInviteLinkClientResult> {
  try {
    const res = await fetch("/api/pro/invite-links", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: input.kind,
        label: input.label,
        workspaceId: input.workspaceId || undefined,
        assignedPropertyIds: input.assignedPropertyIds,
        propertyPermissions: input.propertyPermissions,
        propertyLabelsById: input.propertyLabelsById,
        expiry: input.expiry,
        uses: input.uses,
        teamRole: input.teamRole,
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      url?: string;
      link?: { id?: string };
      error?: string;
    };
    if (!res.ok || !body.url) {
      return { ok: false, error: body.error ?? "Could not create the invite link." };
    }
    return { ok: true, url: body.url, linkId: String(body.link?.id ?? "") };
  } catch {
    return { ok: false, error: "Could not create the invite link." };
  }
}

export async function revealInviteLinkClient(
  linkId: string,
  rotate = false,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  try {
    const res = await fetch(`/api/pro/invite-links/${encodeURIComponent(linkId)}/link`, {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(rotate ? { rotate: true } : {}),
    });
    const body = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
    if (!res.ok || !body.url) {
      return { ok: false, error: body.error ?? "Could not copy that invite link." };
    }
    return { ok: true, url: body.url };
  } catch {
    return { ok: false, error: "Could not copy that invite link." };
  }
}
