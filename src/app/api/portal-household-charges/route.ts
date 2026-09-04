import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import {
  fetchRowsForManagerWithLinked,
  linkedPropertyIdsForModule,
} from "@/lib/auth/co-manager-module-scope";
import { managerHasCoManagerPermissionForProperty } from "@/lib/auth/manager-lease-scope";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import type { HouseholdCharge } from "@/lib/household-charges";
import { enrichHouseholdChargesFromPropertyRecords } from "@/lib/household-charge-payment-eligibility";
import {
  cancelFuturePaymentRemindersForCharge,
  restoreFuturePaymentRemindersForCharge,
} from "@/lib/payment-reminder-lifecycle.server";
import {
  DEFAULT_MANAGER_AUTOMATION_SETTINGS,
  loadManagerAutomationSettings,
} from "@/lib/payment-automation-settings";
import { ensureChargeDueDateForReminders } from "@/lib/payment-reminder-bootstrap";
import {
  householdChargeLedgerFingerprint,
  reconcileDuplicateChargeList,
  syncLedgerChargeEntry,
} from "@/lib/reports/ledger-sync";
import { emitHouseholdChargeTransition } from "@/lib/domain-action-events.server";

export const runtime = "nodejs";

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
      .select("id, row_data, updated_at")
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

    if (user.role === "admin") {
      // admin sees all
    } else if (user.role === "manager") {
      // Managers see charges they own; also include any where they appear as a resident (edge case)
      chargeQuery = chargeQuery.or(`manager_user_id.eq.${user.id},resident_user_id.eq.${user.id},resident_email.eq.${user.email}`);
      profileQuery = profileQuery.or(`manager_user_id.eq.${user.id},resident_user_id.eq.${user.id},resident_email.eq.${user.email}`);
    } else {
      // Resident — match by user_id or email
      chargeQuery = chargeQuery.or(`resident_user_id.eq.${user.id},resident_email.eq.${user.email}`);
      profileQuery = profileQuery.or(`resident_user_id.eq.${user.id},resident_email.eq.${user.email}`);
    }

    const [chargeResult, profileResult] = await Promise.all([chargeQuery, profileQuery]);
    if (chargeResult.error) return NextResponse.json({ error: chargeResult.error.message }, { status: 500 });
    if (profileResult.error) return NextResponse.json({ error: profileResult.error.message }, { status: 500 });

    type ChargeRecordRow = { id: string; row_data: unknown; updated_at: string | null };
    let chargeRows = (chargeResult.data ?? []) as ChargeRecordRow[];
    if (user.role === "manager") {
      // Co-managers with "payments" access on linked properties also see those charges.
      const linkedPropertyIds = await linkedPropertyIdsForModule(db, user.id, "payments");
      if (linkedPropertyIds.size > 0) {
        const linkedRows = await fetchRowsForManagerWithLinked<ChargeRecordRow>(
          db,
          "portal_household_charge_records",
          user.id,
          linkedPropertyIds,
          { propertyColumns: ["property_id"] },
        );
        const seen = new Set(chargeRows.map((row) => row.id));
        chargeRows = [...chargeRows, ...linkedRows.filter((row) => row.id && !seen.has(row.id))];
      }
    }

    const rawCharges = chargeRows.map((r) => r.row_data as HouseholdCharge);
    const charges = await enrichHouseholdChargesFromPropertyRecords(db, rawCharges);
    const rentProfiles = (profileResult.data ?? []).map((r) => r.row_data);
    return NextResponse.json({ charges, rentProfiles });
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

    const body = (await req.json()) as {
      action?: string;
      id?: string;
      charges?: Record<string, unknown>[];
      rentProfiles?: Record<string, unknown>[];
    };
    const now = new Date().toISOString();

    if (body.action === "deleteCharge") {
      const id = body.id?.trim();
      if (!id) return NextResponse.json({ error: "id required" }, { status: 400 });
      if (user.role !== "admin") {
        const { data: existing } = await db
          .from("portal_household_charge_records")
          .select("manager_user_id, property_id")
          .eq("id", id)
          .maybeSingle();
        if (existing && existing.manager_user_id !== user.id) {
          // Foreign row: a co-manager may delete a linked owner's charge only
          // with the payments DELETE grant on its property.
          const pid = existing.property_id ? String(existing.property_id) : null;
          const canDelete = pid
            ? await managerHasCoManagerPermissionForProperty(db, user.id, pid, "payments", "delete")
            : false;
          if (!canDelete) return NextResponse.json({ error: "Forbidden." }, { status: 403 });
        }
      }
      await db.from("portal_household_charge_records").delete().eq("id", id);
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
      const rowData = (existing.row_data ?? {}) as Record<string, unknown>;
      const restoredBalance =
        typeof rowData.amountLabel === "string" && rowData.amountLabel.trim()
          ? rowData.amountLabel
          : (rowData.balanceLabel ?? null);
      const nextRow = {
        ...rowData,
        status: "pending",
        paidAt: null,
        balanceLabel: restoredBalance,
        // Match the client unmark: drop the (past) due date so it lands in Pending,
        // not Overdue, and reopen reminders.
        dueDateLabel: null,
        cancelledReminders: null,
        stripeCheckoutSessionId: null,
      };
      const { error } = await db
        .from("portal_household_charge_records")
        .update({ status: "pending", row_data: nextRow, updated_at: now })
        .eq("id", id);
      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
      await restoreFuturePaymentRemindersForCharge(db, ownerId, id).catch(() => undefined);
      await syncLedgerChargeEntry(db, { ...(nextRow as unknown as HouseholdCharge), managerUserId: ownerId }).catch(
        () => undefined,
      );
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
      const existingLedgerFingerprintById = new Map<string, string>();
      if (chargeIds.length > 0) {
        const { data: existingRows, error: existingRowsError } = await db
          .from("portal_household_charge_records")
          .select("id, status, manager_user_id, property_id, row_data")
          .in("id", chargeIds);
        if (existingRowsError) {
          return NextResponse.json({ error: existingRowsError.message }, { status: 500 });
        }
        for (const row of existingRows ?? []) {
          const id = String(row.id);
          previousStatusById.set(id, typeof row.status === "string" ? row.status : null);
          existingOwnerById.set(id, row.manager_user_id ? String(row.manager_user_id) : null);
          existingPropertyById.set(id, row.property_id ? String(row.property_id) : null);
          if (row.row_data && typeof row.row_data === "object") {
            existingLedgerFingerprintById.set(
              id,
              householdChargeLedgerFingerprint(row.row_data as Record<string, unknown>),
            );
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
        // PAID IS STICKY. The client mirrors its full charge list on nearly every
        // local write; if a charge was marked paid out-of-band (Stripe webhook,
        // another device, a co-manager) while this client still holds a stale
        // pending copy, its mirror must NOT downgrade the paid row back to
        // pending/overdue. Skip any incoming downgrade of a stored-paid charge —
        // the only legitimate revert is action:"unmarkPaid" above.
        if (previousStatusById.get(id) === "paid" && (typeof c.status !== "string" || c.status !== "paid")) {
          continue;
        }
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
        } else {
          managerUserId = user.id;
        }
        mappedRows.push({
          id,
          manager_user_id: managerUserId,
          resident_user_id: toUuid(c.residentUserId),
          resident_email: typeof c.residentEmail === "string" ? c.residentEmail.trim().toLowerCase() : null,
          property_id: propertyId,
          kind: typeof c.kind === "string" ? c.kind : null,
          status: typeof c.status === "string" ? c.status : null,
          row_data: c,
          updated_at: now,
        });
      }
      const rows = mappedRows;
      if (rows.length > 0) {
        const { error } = await db.from("portal_household_charge_records").upsert(rows, { onConflict: "id" });
        if (error) return NextResponse.json({ error: error.message }, { status: 500 });
        // Batch-scoped dedupe only — a full-table sweep on every client mirror
        // was taking tens of seconds and blocking the whole portal load.
        await reconcileDuplicateChargeList(
          db,
          mappedRows.map((row) => row.row_data as HouseholdCharge),
          user.role === "admin" ? undefined : user.id,
          new Set(chargeIds),
        ).catch(() => undefined);
        // Reminders + ledger/GL sync run ONLY over rows that were actually
        // persisted (mappedRows) — NOT the full client list. A foreign charge a
        // read-only co-manager was forbidden to persist (skipped above) must not
        // reach syncLedgerChargeEntry, which would otherwise write owner-attributed
        // ledger/GL rows from the co-manager's untrusted mirror copy. The owner id
        // comes from the row's resolved manager_user_id, not the caller.
        for (const row of mappedRows) {
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
        } else {
          managerUserId = user.id;
        }
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
