import { NextResponse } from "next/server";
import { isAdminUser } from "@/lib/auth/admin-preview";
import { managerCanAccessLeaseRecord, type LeaseScopeRecord } from "@/lib/auth/manager-lease-scope";
import { resolveResidentScopedActorRole } from "@/lib/auth/resident-role-access";
import { autoFileLeaseDocument, type AutoFileLeaseRow } from "@/lib/documents/document-auto-file-hooks.server";
import { buildDurableLeaseTransitionEnvelope } from "@/lib/domain-action-events.server";
import { leaseCanBeMarkedSignedOffPlatform } from "@/lib/lease-execution-evidence";
import { normalizeLeasePipelineRow, type LeasePipelineRow } from "@/lib/lease-pipeline-storage";
import { syncLeaseLifecycleTasks } from "@/lib/manager-default-tasks.server";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";

/**
 * Mark a lease as executed OFF-platform.
 *
 * The generic `/api/portal-lease-pipeline` upsert deliberately refuses two
 * shapes: a signature on a row that was never sent, and a document body plus an
 * execution claim in one request. Both guards exist because that route persists
 * whatever the browser says, so a request must never be able to vouch for its
 * own execution. Marking a paper-signed lease is exactly that shape, so instead
 * of a carve-out it gets its own action: the SERVER writes the signatures, on a
 * document it holds (or is handed here, while no signature exists yet), pinned
 * to the manager it authenticated.
 *
 * Refuses whenever the stored row already carries execution evidence — see
 * `leaseCanBeMarkedSignedOffPlatform`, the same predicate the UI offers the
 * action on.
 */

export const runtime = "nodejs";

const PDF_DATA_URL_PREFIX = "data:application/pdf;base64,";
const MAX_PDF_BYTES = 3.5 * 1024 * 1024;
const OFF_PLATFORM_NOTE = "Lease signed off-platform.";

type MarkSignedBody = {
  leaseId?: unknown;
  /** ISO date (YYYY-MM-DD) or ISO timestamp the parties signed; defaults to now. */
  signedOn?: unknown;
  /** The signed PDF, when the row holds none yet or the manager replaced it. */
  pdf?: { dataUrl?: unknown; fileName?: unknown } | null;
};

function decodedPdfByteLength(dataUrl: string): number {
  const base64 = dataUrl.slice(PDF_DATA_URL_PREFIX.length);
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

function resolveSignedAtIso(signedOn: unknown): string | null {
  if (signedOn == null || signedOn === "") return new Date().toISOString();
  if (typeof signedOn !== "string") return null;
  const trimmed = signedOn.trim();
  // A bare date is the paper lease's date; anchor it to noon UTC so it renders
  // as that calendar day in every US timezone.
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T12:00:00.000Z` : trimmed;
  const parsed = new Date(dateOnly);
  if (Number.isNaN(parsed.getTime())) return null;
  // A signing date in the future is a typo, not a fact.
  if (parsed.getTime() > Date.now() + 24 * 60 * 60 * 1000) return null;
  return parsed.toISOString();
}

export async function POST(req: Request) {
  try {
    const supabase = await createSupabaseServerClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

    const db = createSupabaseServiceRoleClient();
    const { data: profile } = await db.from("profiles").select("email, full_name, role").eq("id", user.id).maybeSingle();
    const admin = await isAdminUser(user.id);
    const role = admin
      ? "admin"
      : await resolveResidentScopedActorRole(db, { userId: user.id, legacyRole: profile?.role ?? user.user_metadata?.role });
    if (role === "resident") {
      return NextResponse.json({ error: "Only a manager can mark a lease as signed." }, { status: 403 });
    }

    const body = (await req.json().catch(() => ({}))) as MarkSignedBody;
    const leaseId = typeof body.leaseId === "string" ? body.leaseId.trim() : "";
    if (!leaseId) return NextResponse.json({ error: "leaseId required" }, { status: 400 });

    const signedAtIso = resolveSignedAtIso(body.signedOn);
    if (!signedAtIso) return NextResponse.json({ error: "Enter a valid signing date." }, { status: 400 });

    let suppliedPdf: { dataUrl: string; fileName: string } | null = null;
    if (body.pdf) {
      const dataUrl = typeof body.pdf.dataUrl === "string" ? body.pdf.dataUrl.trim() : "";
      const fileName = typeof body.pdf.fileName === "string" ? body.pdf.fileName.trim() : "";
      if (!dataUrl.startsWith(PDF_DATA_URL_PREFIX)) {
        return NextResponse.json({ error: "Please choose a PDF file." }, { status: 400 });
      }
      if (decodedPdfByteLength(dataUrl) > MAX_PDF_BYTES) {
        return NextResponse.json({ error: "PDF too large (max 3.5 MB)." }, { status: 400 });
      }
      suppliedPdf = { dataUrl, fileName: fileName || "signed-lease.pdf" };
    }

    const { data: existing, error: loadError } = await db
      .from("portal_lease_pipeline_records")
      .select("id, manager_user_id, resident_user_id, resident_email, property_id, status, row_data, updated_at")
      .eq("id", leaseId)
      .limit(1);
    if (loadError) return NextResponse.json({ error: loadError.message }, { status: 500 });
    const record = (existing ?? [])[0] as
      | (LeaseScopeRecord & { resident_user_id?: string | null; status?: string | null; updated_at?: string | null })
      | undefined;
    // A miss and a row somebody else owns look the same from here: the caller
    // learns nothing about leases outside their portfolio.
    if (!record) return NextResponse.json({ error: "Lease not found." }, { status: 404 });
    if (role !== "admin") {
      const allowed = await managerCanAccessLeaseRecord(db, user.id, record, "edit");
      if (!allowed) return NextResponse.json({ error: "Lease not found." }, { status: 404 });
    }

    const stored = normalizeLeasePipelineRow(record.row_data);
    if (!leaseCanBeMarkedSignedOffPlatform(stored)) {
      const residentSigned = Boolean(stored.residentSignature || stored.residentReturnedSignedPdfAt);
      return NextResponse.json(
        {
          error: residentSigned
            ? `${stored.residentName || "The resident"} already signed this lease in PropLane. Countersign it instead.`
            : stored.status === "Voided"
              ? "This lease was voided. Issue a new version instead."
              : "This lease is already signed.",
        },
        { status: 409 },
      );
    }

    const storedPdf = stored.managerUploadedPdf?.originalDataUrl || stored.managerUploadedPdf?.dataUrl || "";
    if (!suppliedPdf && !storedPdf) {
      return NextResponse.json({ error: "Attach the signed PDF first." }, { status: 400 });
    }

    const iso = new Date().toISOString();
    const managerName = String(profile?.full_name ?? "").trim() || "Property Manager";
    const residentName = stored.residentName?.trim() || "Resident";
    const replacesDocument = Boolean(suppliedPdf && suppliedPdf.dataUrl !== storedPdf);
    const uploadedPdf = replacesDocument
      ? {
          dataUrl: suppliedPdf!.dataUrl,
          originalDataUrl: suppliedPdf!.dataUrl,
          fileName: suppliedPdf!.fileName,
          uploadedAt: iso,
        }
      : stored.managerUploadedPdf ?? null;
    const nextVersion = replacesDocument ? (stored.versionNumber ?? stored.pdfVersion ?? 0) + 1 : stored.versionNumber ?? stored.pdfVersion;
    const signedOnLabel = new Date(signedAtIso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });

    const next = normalizeLeasePipelineRow({
      ...stored,
      bucket: "signed",
      status: "Fully Signed",
      currentActorRole: "system",
      managerUploadedPdf: uploadedPdf,
      // A signed PDF replaces a generated draft; the draft is no longer the
      // agreement. The reading of an upload is derived and never gates an
      // executed filing, so it goes too.
      generatedHtml: replacesDocument ? null : stored.generatedHtml ?? null,
      generatedAtIso: replacesDocument ? null : stored.generatedAtIso ?? null,
      uploadedLeaseParse: null,
      pdfVersion: nextVersion,
      versionNumber: nextVersion,
      managerSignature: { role: "manager", name: managerName, signedAtIso },
      residentSignature: { role: "resident", name: residentName, signedAtIso },
      signatureName: residentName,
      signedAtIso,
      residentSignedAt: signedAtIso,
      managerSignedAt: signedAtIso,
      // Left as stored: a never-sent lease stays never-sent. Stamping it here
      // would read as a "lease sent" transition and message the resident to
      // sign something already signed.
      sentToResidentAt: stored.sentToResidentAt ?? null,
      fullySignedAt: signedAtIso,
      voidedAt: null,
      leaseDocumentRemovedAt: null,
      externallySignedLease: true,
      notes: stored.notes?.trim() ? stored.notes : OFF_PLATFORM_NOTE,
      thread: [
        ...(stored.thread ?? []),
        {
          id: `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          at: iso,
          role: "manager" as const,
          body: `Marked as signed off-platform by ${managerName} (signed ${signedOnLabel}).`,
        },
      ],
      updatedAtIso: iso,
    });

    const persistedRecord = {
      id: record.id,
      manager_user_id: record.manager_user_id ?? null,
      resident_user_id: record.resident_user_id ?? null,
      resident_email: record.resident_email ?? null,
      property_id: record.property_id ?? null,
      status: "signed",
      row_data: next,
      updated_at: iso,
    };
    const managerUserId = record.manager_user_id ?? null;
    const transition = managerUserId
      ? buildDurableLeaseTransitionEnvelope({
          managerUserId,
          previous: stored,
          lease: next,
          actor: {
            userId: user.id,
            email: String(profile?.email ?? user.email ?? "").trim().toLowerCase(),
            name: managerName,
          },
          triggeringActorUserId: user.id,
        })
      : null;
    const { data: persistence, error } = await db.rpc("persist_lease_with_action_event", {
      p_record: persistedRecord,
      p_expected_updated_at: record.updated_at ?? null,
      p_event: transition,
    });
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    if (persistence !== "persisted") {
      return NextResponse.json({ error: "The lease changed in another session. Refresh and try again." }, { status: 409 });
    }

    // Same hook an e-signed lease fires on its transition into fully signed. The
    // bytes are trusted here because the server, not the browser, just declared
    // them executed.
    await autoFileLeaseDocument(db, next as unknown as AutoFileLeaseRow).catch(() => undefined);
    if (managerUserId) {
      void syncLeaseLifecycleTasks(db, managerUserId, stored, next as LeasePipelineRow).catch(() => undefined);
    }

    return NextResponse.json({ ok: true, row: next });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Could not mark the lease as signed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
