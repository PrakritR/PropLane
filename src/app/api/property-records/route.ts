import { clearHousingAccessForDeletedProperty } from "@/lib/auth/clear-property-housing-access";
import { NextResponse } from "next/server";
import { track } from "@/lib/analytics/posthog";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { assertCoManagerModuleAccess } from "@/lib/auth/co-manager-access";
import { asStringArray } from "@/lib/account-link-invite-row";
import { isCrossSandboxPortalPair } from "@/lib/portal-sandbox-accounts";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { upsertPropertyApplicationFeeWaiverCode } from "@/lib/application-fee-waiver";
import { MANAGER_PROPERTY_LIMIT_ERROR_CODE } from "@/lib/manager-access";
import { assertManagerPropertyListingQuota } from "@/lib/manager-property-quota.server";
import { propertyRowsToSnapshot, type ManagerPropertyRecordStatus } from "@/lib/persisted-property-records";

export const runtime = "nodejs";

function listingApplicationFeeWaiverCodeFromPayload(rowData: unknown, propertyData: unknown): string | null {
  const read = (container: unknown): string | null => {
    if (!container || typeof container !== "object") return null;
    const record = container as Record<string, unknown>;
    const submission = record.submission ?? record.listingSubmission;
    if (!submission || typeof submission !== "object") return null;
    const code = (submission as { applicationFeeWaiverCode?: unknown }).applicationFeeWaiverCode;
    return typeof code === "string" ? code.trim() : null;
  };
  const fromRow = read(rowData);
  if (fromRow != null) return fromRow;
  return read(propertyData);
}

async function sessionUser() {
  const supabase = await createSupabaseServerClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return user;
}

export async function GET() {
  try {
    const user = await sessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const admin = await isAdminUser(user.id);
    const db = createSupabaseServiceRoleClient();
    const baseQuery = db
      .from("manager_property_records")
      .select("id, manager_user_id, status, row_data, property_data, edit_request_note")
      .order("created_at", { ascending: true });
    if (admin) {
      const { data, error } = await baseQuery;
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      // Admins get the full inventory; client must scope with its own linked ids.
      return NextResponse.json({ snapshot: propertyRowsToSnapshot(data ?? []), linkedPropertyIds: [] as string[] });
    }

    const { data: viewerProfile } = await db.from("profiles").select("email").eq("id", user.id).maybeSingle();
    const viewerEmail = String(viewerProfile?.email ?? user.email ?? "").trim();

    const { data: linkRows, error: linkError } = await db
      .from("account_link_invites")
      .select("inviter_user_id, assigned_property_ids")
      .eq("status", "accepted")
      .eq("invitee_user_id", user.id);

    if (linkError && !String(linkError.message ?? "").toLowerCase().includes("account_link_invites")) {
      return NextResponse.json({ error: linkError.message }, { status: 500 });
    }

    const inviterIds = [
      ...new Set(
        (linkRows ?? [])
          .map((row) => String((row as { inviter_user_id?: string }).inviter_user_id ?? "").trim())
          .filter(Boolean),
      ),
    ];
    const inviterEmailById = new Map<string, string>();
    if (inviterIds.length > 0) {
      const { data: inviterProfiles } = await db.from("profiles").select("id, email").in("id", inviterIds);
      for (const profile of inviterProfiles ?? []) {
        const id = String(profile.id ?? "").trim();
        const email = String(profile.email ?? "").trim();
        if (id && email) inviterEmailById.set(id, email);
      }
    }

    const linkedPropertyIds = new Set<string>();
    for (const row of linkRows ?? []) {
      const inviterId = String((row as { inviter_user_id?: string }).inviter_user_id ?? "").trim();
      const inviterEmail = inviterEmailById.get(inviterId) ?? "";
      if (isCrossSandboxPortalPair(viewerEmail, inviterEmail)) continue;
      for (const id of asStringArray((row as { assigned_property_ids?: unknown }).assigned_property_ids)) {
        if (id.trim()) linkedPropertyIds.add(id.trim());
      }
    }

    const { data: ownedRows, error } = await baseQuery.eq("manager_user_id", user.id);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    let rows = ownedRows ?? [];
    if (linkedPropertyIds.size > 0) {
      const { data: linkedRows, error: linkedError } = await db
        .from("manager_property_records")
        .select("id, manager_user_id, status, row_data, property_data, edit_request_note")
        .in("id", [...linkedPropertyIds])
        .order("created_at", { ascending: true });

      if (linkedError) return NextResponse.json({ error: linkedError.message }, { status: 500 });

      const seen = new Set(rows.map((row) => row.id));
      rows = [...rows, ...((linkedRows ?? []).filter((row) => !seen.has(row.id)))];
    }

    // Return authoritative linked ids from the same invite query so the client
    // does not re-scope with a stale/empty local relationship cache (which used
    // to drop co-managed listings like Brooklyn from the local pipeline).
    return NextResponse.json({
      snapshot: propertyRowsToSnapshot(rows),
      linkedPropertyIds: [...linkedPropertyIds],
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load property records.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const user = await sessionUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const body = (await req.json()) as {
      action?: "upsert" | "delete";
      id?: string;
      managerUserId?: string | null;
      status?: ManagerPropertyRecordStatus;
      rowData?: unknown;
      propertyData?: unknown;
      editRequestNote?: string | null;
    };
    const id = body.id?.trim();
    if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });

    const admin = await isAdminUser(user.id);
    const db = createSupabaseServiceRoleClient();

    // Look up the stored row's owner ONCE. All authorization anchors on this
    // server-read value, never on body.managerUserId (which a caller controls).
    const { data: existing, error: existingError } = await db
      .from("manager_property_records")
      .select("manager_user_id, status")
      .eq("id", id)
      .maybeSingle();
    // A FAILED read is not an absent row. Falling through would answer 404 on a
    // delete — which `deletePropertyRecordFromServer` reports as success, so the
    // client then drops the local draft and permanently deletes its uploaded
    // photos while the server row is still there — or take the create branch on
    // an upsert, which resolves an owner with no stored owner to authorize
    // against. Only a successful read that found nothing is "not found".
    if (existingError) {
      return NextResponse.json({ error: existingError.message }, { status: 500 });
    }
    const existingOwnerId = existing ? String(existing.manager_user_id ?? "").trim() : "";
    const isDelete = body.action === "delete";

    // A delete of a row that is not there is NOT FOUND — never a create.
    //
    // The create branch below exists to attribute a brand-new record, so it has
    // no stored owner to authorize against and (for a caller who simply omits
    // `managerUserId`) issues no 403 at all. A delete that fell into it was
    // therefore unauthenticated in everything but name, and still ran
    // `clearHousingAccessForDeletedProperty` with the SERVICE-ROLE client —
    // a globally scoped helper that scans and rewrites `account_link_invites`,
    // `manager_application_records` and `portal_pro_relationship_records`
    // across EVERY manager. Any signed-in account could aim that at an
    // arbitrary id. (The helper now also matches ids EXACTLY, which closes the
    // neighbouring step of the same attack — see its own doc comment.)
    //
    // Refusing here is what keeps the invariant simple: the cleanup helper is
    // reachable only after `existing` is a real row AND the authorization below
    // has passed on it.
    if (isDelete && !existing) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    // Resolve who the write is attributed to, and authorize the caller. Two
    // invariants hold here:
    //
    // 1. ONLY a missing row is a create, and only an UPSERT is. An existing row
    //    — including one whose `manager_user_id` is blank because the column is
    //    `on delete set null` — is always routed through the authorization
    //    below, so an orphaned listing can never be adopted (or deleted) by
    //    any signed-in account that happens to know its public listing id; and
    //    a delete has already been refused above when the row is missing, so it
    //    can never take the create branch's owner-less path.
    // 2. An EXISTING row that HAS an owner keeps that owner on every write, admins
    //    included. Every client that posts here mirrors `managerUserId` straight
    //    out of a browser-local pipeline bucket
    //    (`mirrorLocalPropertyPipelineToServer`, `mirrorAdminPropertyRecord`,
    //    `promoteLegacyPendingListingsToLive`), so honoring it let a stale local
    //    bucket keyed by another user id silently hand live listings to that
    //    account. The read path scopes strictly by `manager_user_id`, so the real
    //    manager's Properties tab then showed 0/0/0 while Residents, Applications,
    //    and the Communication filter — which read denormalized property labels off
    //    application/lease rows — kept showing the same houses. Ownership changes
    //    have exactly one door: `transferPropertyOwnership` (linked co-manager,
    //    audited, notifies both sides).
    // `null` is a REAL value here, not "unknown": `manager_user_id` is
    // `references auth.users(id) on delete set null`, so a deleted manager
    // leaves live listings genuinely ownerless. It is never `""` — an empty
    // string is not a uuid and Postgres rejects the whole upsert with
    // `invalid input syntax for type uuid`, which surfaced as a 500 on an
    // ordinary co-manager save.
    let ownerForWrite: string | null;
    if (!existing) {
      // Creating a brand-new record. An admin may attribute it to a manager —
      // the admin inventory publishes on a manager's behalf — but a co-manager
      // cannot create a property owned by someone else.
      ownerForWrite = body.managerUserId?.trim() || user.id;
      if (!admin && ownerForWrite !== user.id) {
        return NextResponse.json({ error: "Forbidden." }, { status: 403 });
      }
    } else if (admin) {
      // Never MOVE a row that still has an owner; an orphaned row (the column is
      // `on delete set null`) may still be re-attributed by an admin.
      ownerForWrite = existingOwnerId || body.managerUserId?.trim() || user.id;
    } else if (existingOwnerId === user.id) {
      // The owner editing / deleting their own listing.
      ownerForWrite = user.id;
    } else {
      // Co-manager acting on a linked owner's listing: require the `properties`
      // module at edit (write) or delete level on THIS property. The owner is
      // preserved on write so a co-manager can never reassign ownership.
      const access = await assertCoManagerModuleAccess(db, user.id, id, "properties", {
        ownerManagerUserId: existingOwnerId,
        level: isDelete ? "delete" : "edit",
      });
      if (!access.ok) {
        return NextResponse.json({ error: access.error }, { status: access.status });
      }
      // Preserve the stored owner verbatim, INCLUDING an absent one. The grant
      // that authorized this write is the accepted link's
      // `assigned_property_ids` — `assertCoManagerModuleAccess` never consults
      // the owner — so an ownerless listing stays ownerless and the co-manager
      // keeps their access through that grant. Writing `user.id` here instead
      // would let a linked co-manager silently ADOPT an orphaned listing, which
      // is exactly the transfer this route was hardened to prevent; ownership
      // still has one door, `transferPropertyOwnership`.
      ownerForWrite = existingOwnerId || null;
    }

    if (isDelete) {
      const { error } = await db.from("manager_property_records").delete().eq("id", id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      try {
        await clearHousingAccessForDeletedProperty(db, id);
      } catch (cleanupErr) {
        const message = cleanupErr instanceof Error ? cleanupErr.message : "Housing cleanup failed.";
        return NextResponse.json({ error: message }, { status: 500 });
      }
      track("property_deleted", user.id, { property_id: id });
      return NextResponse.json({ ok: true });
    }

    if (!body.status) return NextResponse.json({ error: "status required" }, { status: 400 });

    // One chokepoint between owner resolution and the uuid column. Every branch
    // above already resolves to a uuid or an explicit `null`, so this only ever
    // fires if a future branch reintroduces a blank — and a blank must become
    // `null` (the row's true state) rather than a 500 on a routine save. It
    // cannot launder a client-supplied owner: `body.managerUserId` only ever
    // reaches `ownerForWrite` on the create and admin branches.
    const managerUserIdForWrite = ownerForWrite?.trim() ? ownerForWrite.trim() : null;

    // The plan's property-listing cap, enforced HERE rather than only in the
    // wizard that normally calls this route. Every client posts here directly,
    // so a hidden "+ Add property" button was the entire limit: publishing a
    // second listing on Free needed nothing more than skipping the interface
    // (audit F-SET-1).
    //
    // It charges only a write that moves the record INTO a listing slot, and
    // the owner and the count are both resolved server-side — `ownerForWrite`
    // above already refuses to take an owner from the request body. An account
    // that is over its cap keeps every listing it has; it just cannot add
    // another. Admins are not exempt: publishing on a manager's behalf still
    // spends that manager's plan.
    const quota = await assertManagerPropertyListingQuota(db, {
      ownerUserId: managerUserIdForWrite,
      recordId: id,
      nextStatus: body.status,
      existingStatus: (existing as { status?: string } | null)?.status ?? null,
    });
    if (!quota.ok) {
      return NextResponse.json(
        quota.status === 403
          ? {
              error: quota.error,
              code: MANAGER_PROPERTY_LIMIT_ERROR_CODE,
              tier: quota.tier,
              limit: quota.limit,
              current: quota.current,
            }
          : { error: quota.error },
        { status: quota.status },
      );
    }

    const { error } = await db.from("manager_property_records").upsert(
      {
        id,
        manager_user_id: managerUserIdForWrite,
        status: body.status,
        row_data: body.rowData ?? null,
        property_data: body.propertyData ?? null,
        edit_request_note: body.editRequestNote ?? null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "id" },
    );
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });

    if (managerUserIdForWrite) {
      const waiverCode = listingApplicationFeeWaiverCodeFromPayload(body.rowData, body.propertyData);
      if (waiverCode != null) {
        const waiverResult = await upsertPropertyApplicationFeeWaiverCode(
          db,
          managerUserIdForWrite,
          id,
          waiverCode,
        );
        if (!waiverResult.ok) {
          return NextResponse.json({ error: waiverResult.error }, { status: 400 });
        }
      }
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to save property record.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
