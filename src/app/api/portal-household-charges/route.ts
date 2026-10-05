import { NextResponse } from "next/server";
import { isDeepStrictEqual } from "node:util";
import { isAdminUser } from "@/lib/auth/admin-preview";
import {
  fetchRowsForManagerWithLinked,
  linkedPropertyIdsForModule,
  resolveManagerWorkspaceRowScope,
  rowInWorkspaceScope,
  workspaceRowFilterClause,
  type ManagerWorkspaceRowScope,
} from "@/lib/auth/co-manager-module-scope";
import { managerHasCoManagerPermissionForProperty } from "@/lib/auth/manager-lease-scope";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import type { HouseholdCharge } from "@/lib/household-charges";
import { advanceStaleProcessingHouseholdCharges } from "@/lib/household-charges";
import { enrichHouseholdChargesFromPropertyRecords } from "@/lib/household-charge-payment-eligibility.server";
import {
  cancelFuturePaymentRemindersForCharge,
} from "@/lib/payment-reminder-lifecycle.server";
import {
  DEFAULT_MANAGER_AUTOMATION_SETTINGS,
  loadManagerAutomationSettings,
} from "@/lib/payment-automation-settings";
import { ensureChargeDueDateForReminders } from "@/lib/payment-reminder-bootstrap";
import {
  deleteLedgerEntriesForCharge,
  householdChargeLedgerFingerprint,
  reconcileDuplicateChargeList,
  syncLedgerChargeEntry,
  syncLedgerPaymentEntry,
} from "@/lib/reports/ledger-sync";
import { emitHouseholdChargeTransition } from "@/lib/domain-action-events.server";
import { resolvePropertyPayoutOwners } from "@/lib/payments/property-payout-owner.server";

export const runtime = "nodejs";

/**
 * The ACH `processing` -> `paid` shortcut exists so a developer does not have to wait three days
 * for a Stripe webhook that never fires on localhost. Captain's decision (2026-10-03): it runs on
 * a LOCAL dev server only — never on preview/staging/production, and never on any Vercel
 * deployment at all, whatever `VERCEL_ENV` happens to say. On a deployment the webhook is the only
 * thing that settles a debit, so a bounced one stays bounced.
 */
function localDevAchShortcutAllowed(): boolean {
  return process.env.NODE_ENV === "development" && !process.env.VERCEL && !process.env.VERCEL_ENV;
}

function toUuid(id: unknown): string | null {
  if (!id || typeof id !== "string") return null;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return id;
  return null;
}

async function getUserContext() {
  const supabase = await createSupabaseServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const db = createSupabaseServiceRoleClient();
  const [profileResult, rolesResult] = await Promise.all([
    db.from("profiles").select("email, role").eq("id", user.id).maybeSingle(),
    db.from("profile_roles").select("role").eq("user_id", user.id),
  ]);
  const profile = profileResult.data;
  const admin = await isAdminUser(user.id);
  const roleRows = (rolesResult.data ?? []).map((r) => String(r.role).toLowerCase());
  const legacyRole = String(profile?.role ?? user.user_metadata?.role ?? "").toLowerCase();
  const allRoles = roleRows.length > 0 ? roleRows : (legacyRole ? [legacyRole] : []);
  const isManagerOrOwner = allRoles.some((r) => r === "manager" || r === "owner");
  const resolvedRole = admin ? "admin" : isManagerOrOwner ? "manager" : "resident";
  return {
    db,
    user: {
      id: user.id,
      email: (profile?.email ?? user.email ?? "").trim().toLowerCase(),
      role: resolvedRole,
    },
  };
}

export async function GET() {
  try {
    const ctx = await getUserContext();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const { db, user } = ctx;

    let chargeQuery = db
      .from("portal_household_charge_records")
      .select("id, row_data, manager_user_id, updated_at")
      .order("updated_at", { ascending: false })
      // Higher bound so a high-volume manager's older paid rows stay in the
      // snapshot (missing paid rows would vanish from the UI; the server-side
      // paid-sticky guard already prevents any revert).
      .limit(2000);
    let profileQuery = db
      .from("portal_recurring_rent_profile_records")
      .select("id, row_data, updated_at")
      .order("updated_at", { ascending: false })
      .limit(500);

    // Resolved once per request: the active workspace narrows a manager's own
    // rows below (both the direct query here and the co-manager fetch), and
    // is reused by POST to refuse a write outside it. Admins and residents
    // are never narrowed by a manager's workspace.
    const workspaceScope: ManagerWorkspaceRowScope =
      user.role === "manager"
        ? await resolveManagerWorkspaceRowScope(db, user.id)
        : { propertyIds: null, untaggedOwnedVisible: true };

    if (user.role === "admin") {
      // admin sees all
    } else if (user.role === "manager") {
      // Managers see charges they own (narrowed to the active workspace);
      // also include any where they appear as a resident (edge case), which
      // is never workspace-scoped since that is the manager's OWN resident
      // data, not a house they manage.
      const managerClause =
        workspaceScope.propertyIds === null
          ? `manager_user_id.eq.${user.id}`
          : (() => {
              const inner = workspaceRowFilterClause(["property_id"], workspaceScope.propertyIds, workspaceScope.untaggedOwnedVisible);
              return inner ? `and(manager_user_id.eq.${user.id},${inner})` : null;
            })();
      const branches = [managerClause, `resident_user_id.eq.${user.id}`, `resident_email.eq.${user.email}`].filter(
        (clause): clause is string => Boolean(clause),
      );
      chargeQuery = chargeQuery.or(branches.join(","));
      profileQuery = profileQuery.or(branches.join(","));
    } else {
      // Resident — match by user_id or email
      chargeQuery = chargeQuery.or(`resident_user_id.eq.${user.id},resident_email.eq.${user.email}`);
      profileQuery = profileQuery.or(`resident_user_id.eq.${user.id},resident_email.eq.${user.email}`);
    }

    const [chargeResult, profileResult] = await Promise.all([chargeQuery, profileQuery]);
    if (chargeResult.error) return NextResponse.json({ error: chargeResult.error.message }, { status: 500 });
    if (profileResult.error) return NextResponse.json({ error: profileResult.error.message }, { status: 500 });

    type ChargeRecordRow = { id: string; row_data: unknown; manager_user_id?: string | null; updated_at: string | null };
    let chargeRows = (chargeResult.data ?? []) as ChargeRecordRow[];
    if (user.role === "manager") {
      // Co-managers with "payments" access on linked properties also see those charges —
      // narrowed to the active workspace's houses the same way as the owned branch above,
      // so a granted house is reachable only in the workspace that holds it.
      const linkedPropertyIds = await linkedPropertyIdsForModule(db, user.id, "payments");
      if (linkedPropertyIds.size > 0) {
        const linkedRows = await fetchRowsForManagerWithLinked<ChargeRecordRow>(
          db,
          "portal_household_charge_records",
          user.id,
          linkedPropertyIds,
          { propertyColumns: ["property_id"], workspaceScope },
        );
        const seen = new Set(chargeRows.map((row) => row.id));
        chargeRows = [...chargeRows, ...linkedRows.filter((row) => row.id && !seen.has(row.id))];
      }
    }

    const rawCharges = chargeRows.map((r) => {
      const charge = r.row_data as HouseholdCharge;
      // A propertyless one-off has no property owner to consult. The stored
      // charge column names its manager; row_data must not choose whose account
      // policy the resident sees before checkout.
      return !charge.propertyId?.trim() && r.manager_user_id
        ? { ...charge, managerUserId: r.manager_user_id }
        : charge;
    });
    const advanced = localDevAchShortcutAllowed()
      ? advanceStaleProcessingHouseholdCharges(rawCharges)
      : rawCharges;
    if (advanced !== rawCharges && user.role === "resident") {
      const now = new Date().toISOString();
      for (let i = 0; i < advanced.length; i += 1) {
        if (advanced[i] === rawCharges[i]) continue;
        const charge = advanced[i]!;
        // Only a row STILL processing may be flipped: a webhook that wrote `failed` (or `paid`) in
        // the meantime is the authority, and this read must never overwrite it.
        const { data: written, error } = await db
          .from("portal_household_charge_records")
          .update({ status: charge.status, row_data: charge, updated_at: now })
          .eq("id", charge.id)
          .eq("status", "processing")
          .select("id");
        if (error || ((written ?? []) as unknown[]).length === 0) continue;
        // Ledger is write-through: a charge that reads paid without a payment entry is a figure
        // the reports cannot explain, even on a developer's machine.
        await syncLedgerPaymentEntry(db, charge, charge.paidAt).catch(() => undefined);
      }
    }
    const charges = await enrichHouseholdChargesFromPropertyRecords(db, advanced);
    const rentProfiles = (profileResult.data ?? []).map((r) => r.row_data);
    // The viewer's role travels with the read so the browser store can refuse a
    // write it is not allowed to make (PRP-391) instead of discovering it from a
    // 403. The POST guard below is still the authority; this is the second copy.
    return NextResponse.json({ charges, rentProfiles, viewerRole: user.role });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load charges.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const ctx = await getUserContext();
    if (!ctx) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const { db, user } = ctx;

    if (user.role === "resident") {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    // Resolved once per request: the active workspace refuses a write
    // (create, edit, delete) on a row outside it. Admins are never narrowed.
    const workspaceScope: ManagerWorkspaceRowScope =
      user.role === "manager"
        ? await resolveManagerWorkspaceRowScope(db, user.id)
        : { propertyIds: null, untaggedOwnedVisible: true };

    const body = (await req.json()) as {
      action?: string;
      id?: string;
      paidAt?: string;
      method?: string;
      note?: string;
      charges?: Record<string, unknown>[];
      rentProfiles?: Record<string, unknown>[];
    };
    const now = new Date().toISOString();

    if (body.action === "recordOfflinePayment") {
      const id = typeof body.id === "string" ? body.id.trim() : "";
      const paidAt = typeof body.paidAt === "string" ? new Date(body.paidAt) : new Date(NaN);
      const method = typeof body.method === "string" ? body.method : "";
      if (!id || !Number.isFinite(paidAt.getTime()) || paidAt.getTime() > Date.now() || !["Cash", "Check", "Bank transfer", "Other"].includes(method) || (body.note != null && typeof body.note !== "string") || (body.note?.length ?? 0) > 2000) {
        return NextResponse.json({ error: "Invalid offline receipt." }, { status: 400 });
      }
      const { data: existing, error: readError } = await db.from("portal_household_charge_records")
        .select("manager_user_id, property_id, status, row_data, updated_at").eq("id", id).maybeSingle();
      if (readError) return NextResponse.json({ error: "Could not read charge." }, { status: 500 });
      if (!existing) return NextResponse.json({ error: "Charge not found." }, { status: 404 });
      const ownerId = String(existing.manager_user_id ?? "");
      const propertyId = existing.property_id ? String(existing.property_id) : null;
      if (!ownerId || (user.role !== "admin" && (!rowInWorkspaceScope(propertyId, workspaceScope) || (ownerId !== user.id && !(propertyId && await managerHasCoManagerPermissionForProperty(db, user.id, propertyId, "payments", "edit")))))) {
        return NextResponse.json({ error: "Forbidden." }, { status: 403 });
      }
      const current = existing.row_data as HouseholdCharge;
      const note = body.note?.trim() ?? "";
      // A retry after ledger failure repairs the same receipt; it never changes a paid charge.
      const sameReceipt = existing.status === "paid" && current.paidAt === paidAt.toISOString() && current.paidMethod === method && (current.paidNote ?? "") === note;
      if (!sameReceipt && !["pending", "failed"].includes(existing.status)) {
        return NextResponse.json({ error: "Refresh this charge before recording payment." }, { status: 409 });
      }
      const updated: HouseholdCharge = { ...current, id, managerUserId: ownerId, status: "paid", paidAt: paidAt.toISOString(), paidMethod: method, paidNote: note, balanceLabel: "$0.00" };
      if (!sameReceipt) {
        // Compare the server snapshot to prevent a concurrent payment or amount edit being overwritten.
        let update = db.from("portal_household_charge_records").update({ status: "paid", row_data: updated, updated_at: now }).eq("id", id).eq("status", existing.status);
        update = existing.updated_at == null ? update.is("updated_at", null) : update.eq("updated_at", existing.updated_at);
        const { data: saved, error } = await update.select("id").maybeSingle();
        if (error) return NextResponse.json({ error: "Could not record payment." }, { status: 500 });
        if (!saved) return NextResponse.json({ error: "Charge changed. Refresh and try again." }, { status: 409 });
      }
      await syncLedgerPaymentEntry(db, updated);
      await cancelFuturePaymentRemindersForCharge(db, ownerId, id);
      return NextResponse.json({ ok: true, charge: updated });
    }

    if (body.action === "deleteCharge") {
      const id = body.id?.trim();
      if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
      const { data: existing } = await db
        .from("portal_household_charge_records")
        .select("manager_user_id, property_id")
        .eq("id", id)
        .maybeSingle();
      if (user.role !== "admin") {
        if (existing && existing.manager_user_id !== user.id) {
          // Foreign row: a co-manager may delete a linked owner's charge only
          // with the payments DELETE grant on its property.
          const pid = existing.property_id ? String(existing.property_id) : null;
          const canDelete = pid
            ? await managerHasCoManagerPermissionForProperty(db, user.id, pid, "payments", "delete")
            : false;
          if (!canDelete) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
        }
        // The active workspace narrows even a row the caller otherwise owns
        // or has a co-manager grant for — a row outside it is refused, same
        // as it is simply absent from GET.
        if (existing && !rowInWorkspaceScope(existing.property_id ? String(existing.property_id) : null, workspaceScope)) {
          return NextResponse.json({ error: "Forbidden." }, { status: 403 });
        }
      }
      await db.from("portal_household_charge_records").delete().eq("id", id);
      // A deleted charge must stop contributing to the ledger it was mirrored into —
      // otherwise income/delinquency reports keep reading a row for a charge no one
      // can see any more.
      const ownerId = existing?.manager_user_id
        ? String(existing.manager_user_id)
        : user.role === "admin"
          ? null
          : user.id;
      await deleteLedgerEntriesForCharge(db, ownerId, id).catch((err) => {
        console.error("[portal-household-charges] failed to delete ledger entries for charge", id, err);
      });
      return NextResponse.json({ ok: true });
    }

    // Explicit "unmark paid" — the ONLY way to revert a paid charge to pending.
    // The full-list "replace" mirror can never downgrade a paid charge (see the
    // paid-sticky guard below), so a stale client cannot clobber a paid row; a
    // deliberate manager action routes through here instead.
    if (body.action === "unmarkPaid") {
      const id = body.id?.trim();
      if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
      const { data: existing } = await db
        .from("portal_household_charge_records")
        .select("manager_user_id, property_id, status, row_data")
        .eq("id", id)
        .maybeSingle();
      if (!existing) return NextResponse.json({ ok: true });
      const ownerId = existing.manager_user_id ? String(existing.manager_user_id) : user.id;
      if (user.role !== "admin" && ownerId !== user.id) {
        const pid = existing.property_id ? String(existing.property_id) : null;
        const canEdit = pid
          ? await managerHasCoManagerPermissionForProperty(db, user.id, pid, "payments", "edit")
          : false;
        if (!canEdit) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
      }
      if (
        user.role !== "admin" &&
        !rowInWorkspaceScope(existing.property_id ? String(existing.property_id) : null, workspaceScope)
      ) {
        return NextResponse.json({ error: "Forbidden." }, { status: 403 });
      }
      const rowData = (existing.row_data ?? {}) as Record<string, unknown>;
      // This action previously erased the source pointer while leaving its
      // payment ledger/GL cash journal behind. There is no accounting-safe
      // reversal here, for either provider-backed or offline receipts.
      if (existing.status !== "pending" || rowData.paidAt || rowData.stripeCheckoutSessionId || rowData.paidMethod || rowData.paidAmountCents || rowData.stripePaymentStatus) {
        return NextResponse.json({ error: "Receipt correction is not available." }, { status: 409 });
      }
      // Already pending: the client's stale copy may reconcile itself. No
      // financial, provider, reminder, or ledger fields change on this route.
      return NextResponse.json({ ok: true });
    }

    const charges = Array.isArray(body.charges) ? body.charges : [];
    const rentProfiles = Array.isArray(body.rentProfiles) ? body.rentProfiles : [];

    if (charges.length > 0) {
      const reminderSettings = await loadManagerAutomationSettings(db, user.id).catch(
        () => DEFAULT_MANAGER_AUTOMATION_SETTINGS,
      );
      const normalizedCharges = charges.map((raw) => {
        if (!raw.id || raw.status === "paid") return raw;
        const charge = raw as HouseholdCharge;
        const prepared = ensureChargeDueDateForReminders(charge, reminderSettings);
        if (prepared.dueDateLabel === charge.dueDateLabel) return raw;
        return { ...raw, dueDateLabel: prepared.dueDateLabel };
      });

      const chargeIds = normalizedCharges.filter((c) => c.id).map((c) => String(c.id));
      const previousStatusById = new Map<string, string | null>();
      const existingOwnerById = new Map<string, string | null>();
      const existingPropertyById = new Map<string, string | null>();
      const existingUpdatedAtById = new Map<string, string | null>();
      const existingLedgerFingerprintById = new Map<string, string>();
      const existingResidentVisibleAtById = new Map<string, string>();
      const existingRowDataById = new Map<string, Record<string, unknown>>();
      const existingRecordById = new Map<string, Record<string, unknown>>();
      // A lease fee a manager WAIVED (cancelled with `waivedAt`): only the waiver route reverses it.
      const existingWaivedIds = new Set<string>();
      if (chargeIds.length > 0) {
        const { data: existingRows, error: existingRowsError } = await db
          .from("portal_household_charge_records")
          .select("id, status, manager_user_id, resident_user_id, resident_email, property_id, kind, row_data, updated_at")
          .in("id", chargeIds);
        if (existingRowsError) {
          return NextResponse.json({ error: existingRowsError.message }, { status: 500 });
        }
        for (const row of existingRows ?? []) {
          const id = String(row.id);
          existingRecordById.set(id, row as Record<string, unknown>);
          previousStatusById.set(id, typeof row.status === "string" ? row.status : null);
          existingOwnerById.set(id, row.manager_user_id ? String(row.manager_user_id) : null);
          existingPropertyById.set(id, row.property_id ? String(row.property_id) : null);
          existingUpdatedAtById.set(id, typeof row.updated_at === "string" ? row.updated_at : null);
          if (row.row_data && typeof row.row_data === "object") {
            existingRowDataById.set(id, row.row_data as Record<string, unknown>);
            existingLedgerFingerprintById.set(
              id,
              householdChargeLedgerFingerprint(row.row_data as Record<string, unknown>),
            );
            const stamped = (row.row_data as { residentVisibleAt?: unknown }).residentVisibleAt;
            if (typeof stamped === "string" && stamped) existingResidentVisibleAtById.set(id, stamped);
            if (row.status === "cancelled" && (row.row_data as { waivedAt?: unknown }).waivedAt) {
              existingWaivedIds.add(id);
            }
          }
        }
      }

      // Security: the client mirrors its FULL charge list (incl. an owner's rows a
      // co-manager can now SEE) on every write. Never reassign a row owned by
      // another manager to the caller, and require the payments EDIT level to
      // touch a foreign row — otherwise a co-manager's mirror would silently
      // steal/overwrite the owner's charges (adversarial-review CRITICAL).
      const editableForeignProperty = new Map<string, boolean>();
      const canEditForeign = async (propertyId: string | null): Promise<boolean> => {
        const pid = (propertyId ?? "").trim();
        if (!pid) return false;
        if (editableForeignProperty.has(pid)) return editableForeignProperty.get(pid)!;
        const ok = await managerHasCoManagerPermissionForProperty(db, user.id, pid, "payments", "edit");
        editableForeignProperty.set(pid, ok);
        return ok;
      };

      // CREATING a charge used to be the one unguarded door. Every check above
      // keys off an EXISTING row, so an id nobody had seen before fell through
      // to "it's mine": stamped with the CALLER as owner and whatever property
      // the body named, with no permission read anywhere in the path. A
      // co-manager with no payments grant could therefore bill an owner's
      // resident — and because checkout reads the payee off the charge row's
      // manager_user_id, that rent then landed in the CO-MANAGER's own bank
      // account, giving one property as many payout accounts as it had
      // managers. A new row is now attributed to the PROPERTY'S owner and needs
      // payments EDIT whenever that owner is not the caller.
      const newChargePropertyIds = normalizedCharges
        .filter((c) => c.id && !existingOwnerById.has(String(c.id)))
        .map((c) => (typeof c.propertyId === "string" ? c.propertyId : ""))
        .filter(Boolean);
      const chargePayoutOwners =
        user.role === "admin" ? null : await resolvePropertyPayoutOwners(db, newChargePropertyIds);

      const mappedRows: Array<{
        id: string;
        manager_user_id: string | null;
        resident_user_id: string | null;
        resident_email: string | null;
        property_id: string | null;
        kind: string | null;
        status: string | null;
        row_data: Record<string, unknown>;
        updated_at: string;
      }> = [];
      for (const c of normalizedCharges) {
        if (!c.id) continue;
        const id = String(c.id);
        // The full-list browser mirror is not a payment authority. A paid or
        // in-flight server row must remain intact even when the browser sends
        // the same status with different provider/receipt fields. A new paid
        // row, or a pending row promoted to paid here, must use the dedicated
        // server-authorized payment path instead.
        const storedStatus = previousStatusById.get(id);
        if (["paid", "processing", "partially_paid", "refunded"].includes(storedStatus ?? "")) continue;
        if (typeof c.status !== "string" || !["pending", "cancelled", "failed"].includes(c.status)) continue;
        // A WAIVER IS STICKY too: a stale tab still holding the pending lease fee must not bring it back.
        // Restoring is a deliberate manager action through /api/manager/lease-fee-waivers.
        if (existingWaivedIds.has(id) && c.status !== "cancelled") continue;
        const clientPropertyId = typeof c.propertyId === "string" ? c.propertyId : null;
        const existingOwner = existingOwnerById.get(id) ?? null;
        let managerUserId: string | null;
        let propertyId = clientPropertyId;
        if (user.role === "admin") {
          managerUserId = toUuid(c.managerUserId) ?? user.id;
        } else if (existingOwner && existingOwner !== user.id) {
          // Foreign row: only writable with payments EDIT on its STORED property
          // (never the client-supplied one, which could be relabeled to a
          // property the caller can edit), and the owner is always preserved.
          const storedProperty = existingPropertyById.get(id) ?? null;
          if (!(await canEditForeign(storedProperty))) continue;
          managerUserId = existingOwner;
          propertyId = storedProperty;
        } else if (!existingOwner) {
          // New row. Resolving the owner from the property the caller NAMED (and
          // checking the grant on that same property) is what makes relabeling
          // pointless: the payee is always whoever owns the property the charge
          // is filed under.
          const resolved = chargePayoutOwners?.get((clientPropertyId ?? "").trim());
          if (resolved && !resolved.ok && resolved.reason === "lookup_failed") {
            // A property that cannot be read is not an unowned property. Refuse
            // rather than guess a payee — the same rule the payout context uses.
            return NextResponse.json(
              { error: "Could not verify the property for this charge. Try again in a moment." },
              { status: 503 },
            );
          }
          const propertyOwner = resolved?.ok ? resolved.ownerUserId : null;
          if (propertyOwner && propertyOwner !== user.id) {
            if (!(await canEditForeign(clientPropertyId))) continue;
            managerUserId = propertyOwner;
          } else {
            // The caller's own property, or a charge filed under no property at
            // all (a manual one-off), which has no owner to attribute it to.
            managerUserId = user.id;
          }
        } else {
          managerUserId = user.id;
        }
        // The active workspace narrows both a CREATE (must land in it) and an
        // UPDATE (must refuse a row outside it) — checked against the row's
        // final resolved property, so a co-manager's foreign row is judged by
        // the same workspace that already scoped their read of it above.
        if (!rowInWorkspaceScope(propertyId, workspaceScope)) continue;
        // `residentVisibleAt` is server-owned (stamped by the reminder route): a
        // client copy that predates the stamp must not strip it on its mirror.
        const storedVisibleAt = existingResidentVisibleAtById.get(id);
        const rowData: Record<string, unknown> = storedVisibleAt && !c.residentVisibleAt
          ? { ...c, residentVisibleAt: storedVisibleAt }
          : { ...c };
        const storedData = existingRowDataById.get(id);
        // A receipt, provider binding, or waiver marker belongs to an explicit
        // server action. Keep any stored values; discard all mirror-supplied
        // values, including on a same-status update of an existing charge.
        for (const key of ["paidAt", "paidAmountCents", "paidMethod", "paidNote", "processingStartedAt",
          "stripeCheckoutSessionId", "stripePaymentStatus", "waivedAt", "waivedByUserId", "waiverReason"] as const) {
          if (storedData && Object.hasOwn(storedData, key)) rowData[key] = storedData[key];
          else delete rowData[key];
        }
        if (rowData.status === "pending") rowData.balanceLabel = rowData.amountLabel;
        if (rowData.status === "cancelled") rowData.balanceLabel = "$0.00";
        mappedRows.push({
          id,
          manager_user_id: managerUserId,
          resident_user_id: toUuid(c.residentUserId),
          resident_email: typeof c.residentEmail === "string" ? c.residentEmail.trim().toLowerCase() : null,
          property_id: propertyId,
          kind: typeof c.kind === "string" ? c.kind : null,
          status: typeof c.status === "string" ? c.status : null,
          row_data: rowData,
          updated_at: now,
        });
      }
      const persistedRows: typeof mappedRows = [];
      let chargeWriteError: string | null = null;
      for (const row of mappedRows) {
        if (existingOwnerById.has(row.id)) {
          const stored = existingRecordById.get(row.id);
          if (stored && isDeepStrictEqual(stored.row_data, row.row_data) &&
              stored.manager_user_id === row.manager_user_id && stored.resident_user_id === row.resident_user_id &&
              stored.resident_email === row.resident_email && stored.property_id === row.property_id &&
              stored.kind === row.kind && stored.status === row.status) continue;
          const expectedStatus = previousStatusById.get(row.id);
          const expectedUpdatedAt = existingUpdatedAtById.get(row.id);
          // A missing version cannot safely be compared; a subsequent load
          // can recover this row without risking a provider settlement.
          if (!expectedStatus || !expectedUpdatedAt) continue;
          const { data, error } = await db.from("portal_household_charge_records")
            .update(row)
            .eq("id", row.id)
            .eq("status", expectedStatus)
            .eq("updated_at", expectedUpdatedAt)
            .select("id");
          if (error) { chargeWriteError = error.message; break; }
          if ((data ?? []).length > 0) persistedRows.push(row);
        } else {
          // Insert-only: a concurrent provider/manager writer may have created
          // this id after our read. Never turn that row into an upsert target.
          const { data, error } = await db.from("portal_household_charge_records").insert(row).select("id");
          if (error?.code === "23505") continue;
          if (error) { chargeWriteError = error.message; break; }
          if ((data ?? []).length > 0) persistedRows.push(row);
        }
      }
      if (persistedRows.length > 0) {
        // Batch-scoped dedupe only — a full-table sweep on every client mirror
        // was taking tens of seconds and blocking the whole portal load.
        await reconcileDuplicateChargeList(
          db,
          persistedRows.map((row) => row.row_data as HouseholdCharge),
          user.role === "admin" ? undefined : user.id,
          new Set(chargeIds),
        ).catch(() => undefined);
        // Reminders + ledger/GL sync run ONLY over rows that were actually
        // persisted (mappedRows) — NOT the full client list. A foreign charge a
        // read-only co-manager was forbidden to persist (skipped above) must not
        // reach syncLedgerChargeEntry, which would otherwise write owner-attributed
        // ledger/GL rows from the co-manager's untrusted mirror copy. The owner id
        // comes from the row's resolved manager_user_id, not the caller.
        for (const row of persistedRows) {
          const chargeId = row.id;
          const nextStatus = row.status;
          if (!nextStatus) continue;
          const managerId = row.manager_user_id ?? user.id;
          const prevStatus = previousStatusById.get(chargeId) ?? null;
          const nextFingerprint = householdChargeLedgerFingerprint(row.row_data);
          const prevFingerprint = existingLedgerFingerprintById.get(chargeId);
          const isNewRow = !existingOwnerById.has(chargeId);
          if (!isNewRow && prevFingerprint === nextFingerprint) continue;
          if (nextStatus === "paid" && prevStatus !== "paid") {
            await cancelFuturePaymentRemindersForCharge(db, managerId, chargeId).catch(() => undefined);
          }
          // No paid→pending branch here: the paid-sticky guard skips those rows,
          // so a downgrade can only arrive via action:"unmarkPaid" (which restores
          // reminders itself). A stale mirror can no longer revert a paid charge.
          // Attribute the ledger/GL entry to the SERVER-resolved owner, not the
          // client-supplied row_data.managerUserId (which a caller controls).
          await syncLedgerChargeEntry(db, { ...(row.row_data as HouseholdCharge), managerUserId: managerId }).catch(
            () => undefined,
          );
          await emitHouseholdChargeTransition(db, {
            managerUserId: managerId,
            previousStatus: prevStatus,
            charge: { ...(row.row_data as HouseholdCharge), managerUserId: managerId },
            transitionId: `${chargeId}:${nextStatus}:${now}`,
          }).catch(() => undefined);
        }
      }
      if (chargeWriteError) return NextResponse.json({ error: chargeWriteError }, { status: 500 });
    }

    if (rentProfiles.length > 0) {
      const candidates = rentProfiles.filter((p) => p.id);

      // Same mirror-trust problem as the charge rows above: the client sends its
      // full recurring-rent profile list, so an id owned by another manager must
      // never be reassigned to the caller. Look up the stored owner/property and
      // require payments EDIT on the STORED property to touch a foreign row.
      const profileOwnerById = new Map<string, string | null>();
      const profilePropertyById = new Map<string, string | null>();
      if (user.role !== "admin" && candidates.length > 0) {
        const { data: existingProfiles, error: existingProfilesError } = await db
          .from("portal_recurring_rent_profile_records")
          .select("id, manager_user_id, property_id")
          .in(
            "id",
            candidates.map((p) => String(p.id)),
          );
        if (existingProfilesError) {
          return NextResponse.json({ error: existingProfilesError.message }, { status: 500 });
        }
        for (const row of existingProfiles ?? []) {
          profileOwnerById.set(String(row.id), row.manager_user_id ? String(row.manager_user_id) : null);
          profilePropertyById.set(String(row.id), row.property_id ? String(row.property_id) : null);
        }
      }

      const editableProfileProperty = new Map<string, boolean>();
      const canEditForeignProfile = async (propertyId: string | null): Promise<boolean> => {
        const pid = (propertyId ?? "").trim();
        if (!pid) return false;
        if (editableProfileProperty.has(pid)) return editableProfileProperty.get(pid)!;
        const ok = await managerHasCoManagerPermissionForProperty(db, user.id, pid, "payments", "edit");
        editableProfileProperty.set(pid, ok);
        return ok;
      };

      // A recurring rent profile mints future charges, so creating one is the
      // same authority as creating a charge and takes the same gate.
      const newProfilePropertyIds = candidates
        .filter((p) => !profileOwnerById.has(String(p.id)))
        .map((p) => (typeof p.propertyId === "string" ? p.propertyId : ""))
        .filter(Boolean);
      const profilePayoutOwners =
        user.role === "admin" ? null : await resolvePropertyPayoutOwners(db, newProfilePropertyIds);

      const rows: Array<{
        id: string;
        manager_user_id: string | null;
        resident_user_id: string | null;
        resident_email: string | null;
        property_id: string | null;
        active: boolean;
        row_data: Record<string, unknown>;
        updated_at: string;
      }> = [];
      for (const p of candidates) {
        const id = String(p.id);
        let managerUserId: string | null;
        let propertyId = typeof p.propertyId === "string" ? p.propertyId : null;
        const existingOwner = profileOwnerById.get(id) ?? null;
        if (user.role === "admin") {
          managerUserId = toUuid(p.managerUserId) ?? user.id;
        } else if (existingOwner && existingOwner !== user.id) {
          const storedProperty = profilePropertyById.get(id) ?? null;
          if (!(await canEditForeignProfile(storedProperty))) continue;
          managerUserId = existingOwner;
          propertyId = storedProperty;
        } else if (!existingOwner) {
          const resolved = profilePayoutOwners?.get((propertyId ?? "").trim());
          if (resolved && !resolved.ok && resolved.reason === "lookup_failed") {
            return NextResponse.json(
              { error: "Could not verify the property for this rent schedule. Try again in a moment." },
              { status: 503 },
            );
          }
          const propertyOwner = resolved?.ok ? resolved.ownerUserId : null;
          if (propertyOwner && propertyOwner !== user.id) {
            if (!(await canEditForeignProfile(propertyId))) continue;
            managerUserId = propertyOwner;
          } else {
            managerUserId = user.id;
          }
        } else {
          managerUserId = user.id;
        }
        if (!rowInWorkspaceScope(propertyId, workspaceScope)) continue;
        rows.push({
          id,
          manager_user_id: managerUserId,
          resident_user_id: toUuid(p.residentUserId),
          resident_email: typeof p.residentEmail === "string" ? p.residentEmail.trim().toLowerCase() : null,
          property_id: propertyId,
          active: p.active !== false,
          row_data: p,
          updated_at: now,
        });
      }
      if (rows.length > 0) {
        const { error } = await db.from("portal_recurring_rent_profile_records").upsert(rows, { onConflict: "id" });
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      }
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to save charges.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
