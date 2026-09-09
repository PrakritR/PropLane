import { NextResponse } from "next/server";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { track } from "@/lib/analytics/posthog";
import { notifyApplicantApplicationSms } from "@/lib/application-lifecycle-sms.server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { linkedOwnerScopeForModule, linkedPropertyIdsForModule } from "@/lib/auth/co-manager-module-scope";
import { canManageResidentApproval, setResidentApprovalForManager } from "@/lib/resident-approval.server";
import { resolveResidentScopedActorRole } from "@/lib/auth/resident-role-access";
import { normalizeApplicationAxisId } from "@/lib/manager-applications-storage";
import { isWithdrawnApplicationRow } from "@/lib/rental-application/resident-application-list";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

export const runtime = "nodejs";

/** Rows scanned when resolving the withdrawn stamp by applicant email (newest first). */
const EMAIL_FALLBACK_SCAN_LIMIT = 20;

type WithdrawnLookup = {
  error: boolean;
  stored: DemoApplicantRow | null;
  storedId: string;
  matchedBy: "id" | "email";
};

type StoredApprovalApplication = {
  id: string;
  resident_email: string | null;
  manager_user_id: string | null;
  property_id: string | null;
  assigned_property_id: string | null;
  row_data: DemoApplicantRow | null;
};

function normalizeEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function idVariants(id: string): string[] {
  const trimmed = id.trim();
  const normalized = normalizeApplicationAxisId(trimmed);
  return [
    ...new Set(
      [trimmed, trimmed.toUpperCase(), normalized, normalized.toUpperCase()].filter(Boolean),
    ),
  ];
}

export async function PATCH(req: Request) {
  try {
    const auth = await createSupabaseServerClient();
    const {
      data: { user },
    } = await auth.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    }

    let body: { email?: unknown; approved?: unknown; applicationId?: unknown; notifySms?: unknown; notifyEmail?: unknown };
    try {
      body = (await req.json()) as { email?: unknown; approved?: unknown; applicationId?: unknown; notifySms?: unknown; notifyEmail?: unknown };
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
    }

    const email = normalizeEmail(body.email);
    const approved = typeof body.approved === "boolean" ? body.approved : null;
    const applicationId = typeof body.applicationId === "string" ? body.applicationId.trim() : "";
    const notifySms = body.notifySms === true;
    // This selection changes only truthful copy; identity and authorization stay server-derived.
    const notifyEmail = body.notifyEmail === true;
    if (!email || approved == null) {
      return NextResponse.json({ error: "Email and approved are required." }, { status: 400 });
    }

    const svc = createSupabaseServiceRoleClient();
    const { data: requestor, error: requestorError } = await svc
      .from("profiles")
      .select("role, email, sms_from_number")
      .eq("id", user.id)
      .maybeSingle();

    if (requestorError || !requestor) {
      return NextResponse.json({ error: requestorError?.message ?? "Profile not found." }, { status: 403 });
    }

    // The shared resolver consults profile_roles and applies active-portal
    // semantics for multi-role accounts. Never branch on profiles.role alone.
    const actorRole = await resolveResidentScopedActorRole(svc, {
      userId: user.id,
      legacyRole: requestor.role,
    });
    const actorIsResident = actorRole === "resident";
    const actorCanManage = canManageResidentApproval(actorRole);
    const actorIsAdmin = actorRole === "admin" || (await isAdminUser(user.id));

    const requestorEmail = normalizeEmail(requestor.email);
    if (actorIsResident) {
      if (requestorEmail !== email) {
        return NextResponse.json({ error: "Residents may only update their own access status." }, { status: 403 });
      }
    } else if (!actorCanManage) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }

    let notificationApplication: StoredApprovalApplication | null = null;

    // A selected approval SMS must be derived from the exact stored application.
    // Request email and id identify the operation but never select a recipient,
    // phone, owner, or co-manager scope for a notification.
    if (!actorIsResident && approved && notifySms) {
      if (!applicationId) {
        return NextResponse.json({ error: "An application id is required to send an approval text." }, { status: 400 });
      }
      const { data, error } = await svc
        .from("manager_application_records")
        .select("id, resident_email, manager_user_id, property_id, assigned_property_id, row_data")
        .in("id", idVariants(applicationId))
        .limit(1)
        .maybeSingle();
      if (error) return NextResponse.json({ error: "Could not verify the application for SMS." }, { status: 500 });
      const stored = data as StoredApprovalApplication | null;
      if (!stored || normalizeEmail(stored.resident_email) !== email) {
        return NextResponse.json({ error: "The application does not match this applicant." }, { status: 403 });
      }
      if (stored.row_data?.bucket !== "approved" || isWithdrawnApplicationRow(stored.row_data)) {
        return NextResponse.json({ error: "The stored application is not approved for notification." }, { status: 409 });
      }
      const ownerId = String(stored.manager_user_id ?? "").trim();
      let allowed = actorIsAdmin || ownerId === user.id;
      if (!allowed) {
        const [applicationScope, residentScope] = await Promise.all([
          linkedOwnerScopeForModule(svc, user.id, "applications", "edit"),
          linkedOwnerScopeForModule(svc, user.id, "residents", "edit"),
        ]);
        const propertyIds = new Set<string>([...applicationScope.propertyIds, ...residentScope.propertyIds]);
        const ownerIds = new Set<string>([...applicationScope.ownerIds, ...residentScope.ownerIds]);
        const propertyId = String(stored.property_id ?? "").trim();
        const assignedPropertyId = String(stored.assigned_property_id ?? "").trim();
        allowed = ownerIds.has(ownerId) && Boolean(
          (propertyId && propertyIds.has(propertyId)) || (assignedPropertyId && propertyIds.has(assignedPropertyId)),
        );
      }
      if (!allowed || !ownerId) {
        return NextResponse.json({ error: "Forbidden: application is not in your portfolio." }, { status: 403 });
      }
      notificationApplication = stored;
    }

    // Money-path guard (defense in depth — the manager UI already hides Approve for
    // withdrawn rows): a manager must never approve a resident-withdrawn application.
    // Approving it provisions a resident account + rent/deposit charges for someone
    // who explicitly pulled out. A withdrawal is a reversible stamp, so re-submission
    // (not un-withdraw) is the intended path back to approvable.
    //
    // The ID lookup is deliberately NOT scoped to `manager_user_id`: a co-managed row
    // keeps the linked OWNER's id, and an admin never owns the record, so scoping
    // made the guard silently never fire for exactly the callers the UI check cannot
    // be trusted for. The row is reduced to a single boolean here and no part of it
    // is ever returned to the client. A bogus/unknown `applicationId` must not
    // disable the guard either, so it falls back to a resident-email lookup — and
    // THAT one has no id to anchor on, so it is restricted to records the caller owns
    // or co-manages (an unrelated landlord's withdrawal must never reject this
    // manager's legitimate approval). A query error fails CLOSED (matching
    // `resolveApplicationWriteOwner`).
    if (!actorIsResident && approved) {
      const loadById = async (): Promise<WithdrawnLookup> => {
        const { data, error } = await svc
          .from("manager_application_records")
          .select("id, row_data")
          .in("id", idVariants(applicationId))
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (error) return { error: true, stored: null, storedId: "", matchedBy: "id" };
        return {
          error: false,
          stored: (data?.row_data ?? null) as DemoApplicantRow | null,
          storedId: String(data?.id ?? "").trim(),
          matchedBy: "id",
        };
      };

      const loadByEmail = async (): Promise<WithdrawnLookup> => {
        const { data, error } = await svc
          .from("manager_application_records")
          .select("id, row_data, manager_user_id, property_id, assigned_property_id")
          .eq("resident_email", email)
          .order("updated_at", { ascending: false })
          .limit(EMAIL_FALLBACK_SCAN_LIMIT);
        if (error) return { error: true, stored: null, storedId: "", matchedBy: "email" };
        const records = data ?? [];
        const resolved = async () => {
          if (actorIsAdmin) return records[0] ?? null;
          const owned = records.find((record) => String(record.manager_user_id ?? "") === user.id);
          if (owned) return owned;
          const [appIds, resIds] = await Promise.all([
            linkedPropertyIdsForModule(svc, user.id, "applications"),
            linkedPropertyIdsForModule(svc, user.id, "residents"),
          ]);
          const scopedPropertyIds = new Set<string>([...appIds, ...resIds]);
          return (
            records.find((record) => {
              const pid = String(record.property_id ?? "").trim();
              const assigned = String(record.assigned_property_id ?? "").trim();
              return (pid && scopedPropertyIds.has(pid)) || (assigned && scopedPropertyIds.has(assigned));
            }) ?? null
          );
        };
        const match = await resolved();
        return {
          error: false,
          stored: (match?.row_data ?? null) as DemoApplicantRow | null,
          storedId: String(match?.id ?? "").trim(),
          matchedBy: "email",
        };
      };

      let lookup = applicationId ? await loadById() : null;
      if (lookup?.error) {
        return NextResponse.json({ error: "Could not verify the application status." }, { status: 500 });
      }
      if (!lookup?.stored) {
        lookup = await loadByEmail();
        if (lookup.error) {
          return NextResponse.json({ error: "Could not verify the application status." }, { status: 500 });
        }
      }
      if (lookup.stored && isWithdrawnApplicationRow(lookup.stored)) {
        // The refusal names the record it matched and how. An email-fallback match
        // may be a DIFFERENT application by the same applicant (the approved one's
        // mirror may not have landed yet), so the client can only treat the stamp as
        // this application's when the id lookup is what matched.
        return NextResponse.json(
          {
            error: "This application was withdrawn by the applicant and can no longer be approved.",
            blocked: "withdrawn",
            blockedApplicationId: lookup.storedId || null,
            matchedBy: lookup.matchedBy,
          },
          { status: 409 },
        );
      }
    }

    if (actorIsResident) {
      // Residents may only touch their own row — updated by id, never by email.
      const { error } = await svc
        .from("profiles")
        .update({ application_approved: approved, updated_at: new Date().toISOString() })
        .eq("id", user.id);
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 400 });
      }
    } else {
      // Non-admin managers may only update residents in their own portfolio —
      // enforced inside the shared lib the agent's set_resident_approval tool
      // also runs through, so there is one implementation of that check.
      const result = await setResidentApprovalForManager(svc, { userId: user.id, isAdmin: actorIsAdmin }, { email, approved });
      if (!result.ok) {
        return NextResponse.json({ error: result.error }, { status: result.status });
      }
    }

    // Manager deny → PropLane SMS. Approvals are covered by the welcome + assistant intro.
    // Scoped to the ACTING manager's own application row (never another
    // landlord's data) and deduped so approve/deny toggling can't re-text.
    if (!actorIsResident && !approved) {
      try {
        const { data: appRow } = await svc
          .from("manager_application_records")
          .select("id, row_data, manager_user_id")
          .eq("resident_email", email)
          .eq("manager_user_id", user.id)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (appRow) {
          const dedupId = `application_rejected_sms_${String(appRow.id)}`;
          const { data: alreadySent } = await svc
            .from("portal_outbound_mail_records")
            .select("id")
            .eq("id", dedupId)
            .maybeSingle();
          if (!alreadySent) {
            await svc.from("portal_outbound_mail_records").upsert(
              {
                id: dedupId,
                recipient_email: email,
                subject: "Application decision (SMS)",
                channel: "sms",
                row_data: {
                  id: dedupId,
                  subject: "Application decision (SMS)",
                  sentAt: new Date().toISOString(),
                  applicationId: String(appRow.id),
                },
              },
              { onConflict: "id" },
            );
            const rowData = (appRow.row_data ?? {}) as {
              name?: string;
              propertyTitle?: string;
              application?: { phone?: string; fullLegalName?: string };
            };
            const phone = String(rowData.application?.phone ?? "").trim() || null;
            await notifyApplicantApplicationSms(svc, {
              event: "rejected",
              applicantEmail: email,
              applicantPhone: phone,
              applicantName: rowData.name || rowData.application?.fullLegalName || null,
              propertyTitle: rowData.propertyTitle || null,
              axisId: String(appRow.id),
              managerUserId: String(appRow.manager_user_id ?? user.id).trim() || user.id,
              fromNumber: String(requestor.sms_from_number ?? "").trim() || null,
            });
          }
        }
      } catch {
        /* non-critical */
      }
    }

    let sms: { sms: "submitted" | "queued" | "unknown" | "skipped" | "failed"; error?: string } | undefined;
    if (notificationApplication) {
      const row = notificationApplication.row_data;
      const applicantPhone = String(row?.application?.phone ?? "").trim() || null;
      const notificationRow = row as (DemoApplicantRow & { propertyTitle?: string | null; assignedRoomTitle?: string | null }) | null;
      const room = String(notificationRow?.assignedRoomTitle ?? "").trim();
      const propertyTitle = [String(notificationRow?.propertyTitle ?? row?.property ?? "").trim(), room].filter(Boolean).join(" · ") || null;
      try {
        const outcome = await notifyApplicantApplicationSms(svc, {
          event: "approved",
          applicantEmail: normalizeEmail(notificationApplication.resident_email),
          applicantPhone,
          applicantName: row?.name || row?.application?.fullLegalName || null,
          propertyTitle,
          axisId: String(notificationApplication.id),
          managerUserId: String(notificationApplication.manager_user_id),
          fromNumber: String(requestor.sms_from_number ?? "").trim() || null,
          dedupeKey: `application_approved_sms_${String(notificationApplication.manager_user_id)}_${String(notificationApplication.id)}`,
          setupEmailSelected: notifyEmail,
        });
        const status = String(outcome.outboxStatus ?? "");
        sms = outcome.sent
          ? { sms: "submitted" }
          : outcome.accepted && ["queued", "deferred"].includes(status)
            ? { sms: "queued", ...(outcome.error ? { error: outcome.error } : {}) }
            : outcome.accepted && status === "unknown"
              ? { sms: "unknown", error: "The text was accepted for delivery, but its final outcome is not yet known." }
              : { sms: "failed", ...(outcome.error ? { error: outcome.error } : {}) };
      } catch {
        sms = { sms: "failed", error: "The approval text could not be sent." };
      }
    }

    track("resident_approval_updated", user.id, { approved });
    return NextResponse.json({ ok: true, ...(sms ? { sms } : {}) });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Failed to sync resident approval." },
      { status: 500 },
    );
  }
}
