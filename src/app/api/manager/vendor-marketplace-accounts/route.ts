import { NextResponse } from "next/server";

import { z } from "zod";

import { resolveListingChannelContext } from "@/lib/listing-channels/route-context.server";
import { isVendorMarketplaceId, type VendorMarketplaceAccountRow, type VendorMarketplaceId } from "@/lib/vendor-marketplaces/registry";

export const runtime = "nodejs";

const TABLE = "vendor_marketplace_accounts";
const OWNER_ONLY = "Only the workspace owner can change vendor marketplace accounts.";

const labelSchema = z.string().trim().min(1).max(120);
const profileUrlSchema = z.string().trim().url().max(500).refine((v) => v.startsWith("https://"));

function toRow(raw: Record<string, unknown>): VendorMarketplaceAccountRow {
  return {
    marketplace: String(raw.marketplace) as VendorMarketplaceId,
    accountLabel: String(raw.account_label ?? ""),
    profileUrl: (raw.profile_url as string | null) ?? null,
    connectedAt: String(raw.connected_at ?? ""),
  };
}

/** The accounts the manager has added in the active workspace. Never carries a credential: there is none. */
export async function GET(request: Request) {
  const ctx = await resolveListingChannelContext(request).catch(() => null);
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  const { data, error } = await ctx.db
    .from(TABLE)
    .select("marketplace, account_label, profile_url, connected_at")
    .eq("workspace_id", ctx.workspace.id)
    .order("connected_at", { ascending: true });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ workspaceId: ctx.workspace.id, canManage: ctx.workspace.owned, accounts: (data ?? []).map(toRow) });
}

/** Add or replace the account for one marketplace. A marketplace id outside the registry is refused. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { marketplace?: unknown; accountLabel?: unknown; profileUrl?: unknown; workspaceId?: string | null };
  const ctx = await resolveListingChannelContext(request, body.workspaceId).catch(() => null);
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (!ctx.workspace.owned) return NextResponse.json({ error: OWNER_ONLY }, { status: 403 });

  if (!isVendorMarketplaceId(body.marketplace)) return NextResponse.json({ error: "Unknown marketplace." }, { status: 400 });
  const label = labelSchema.safeParse(body.accountLabel);
  if (!label.success) return NextResponse.json({ error: "Enter the email or name you use there (up to 120 characters)." }, { status: 400 });
  const rawUrl = typeof body.profileUrl === "string" ? body.profileUrl.trim() : "";
  const url = rawUrl === "" ? null : profileUrlSchema.safeParse(rawUrl);
  if (url && !url.success) return NextResponse.json({ error: "The profile link must be a full https:// address." }, { status: 400 });

  const { error } = await ctx.db.from(TABLE).upsert(
    {
      workspace_id: ctx.workspace.id,
      manager_user_id: ctx.workspace.ownerUserId,
      marketplace: body.marketplace,
      account_label: label.data,
      profile_url: url ? url.data : null,
      connected_at: new Date().toISOString(),
    },
    { onConflict: "workspace_id,marketplace" },
  );
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}

/** Remove the account for one marketplace from the active workspace. */
export async function DELETE(request: Request) {
  const body = (await request.json().catch(() => ({}))) as { marketplace?: unknown; workspaceId?: string | null };
  const ctx = await resolveListingChannelContext(request, body.workspaceId).catch(() => null);
  if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
  if (!ctx.workspace.owned) return NextResponse.json({ error: OWNER_ONLY }, { status: 403 });
  if (!isVendorMarketplaceId(body.marketplace)) return NextResponse.json({ error: "Unknown marketplace." }, { status: 400 });

  const { error } = await ctx.db.from(TABLE).delete().eq("workspace_id", ctx.workspace.id).eq("marketplace", body.marketplace);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
