import { NextResponse } from "next/server";
import { resolveVendorPortalUserId } from "@/lib/auth/vendor-api-access";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import type { ManagerVendorRow } from "@/lib/manager-vendors-storage";
import {
  isVendorDocumentKind,
  removeVendorDocument,
  type VendorDocumentKind,
  type VendorDocumentRecord,
} from "@/lib/vendor-documents";
import { resolveOwnVendorRecords, type OwnVendorRecord } from "@/lib/vendor-own-record";

export const runtime = "nodejs";

function expectedDocumentUrl(kind: VendorDocumentKind): string {
  return `/api/vendor/documents/signed-url?kind=${encodeURIComponent(kind)}`;
}

function isStoredVendorDocument(userId: string, doc: VendorDocumentRecord): boolean {
  const storagePath = doc.storagePath?.trim() ?? "";
  return (
    isVendorDocumentKind(doc.kind) &&
    typeof doc.fileName === "string" &&
    typeof doc.url === "string" &&
    doc.url === expectedDocumentUrl(doc.kind) &&
    storagePath.startsWith(`vendor-documents/${userId}/`) &&
    typeof doc.uploadedAt === "string"
  );
}

function mergedVendorDocuments(records: OwnVendorRecord[]): VendorDocumentRecord[] {
  const byKind = new Map<VendorDocumentKind, VendorDocumentRecord>();
  for (const record of records) {
    for (const doc of record.row.vendorDocuments ?? []) {
      if (!isVendorDocumentKind(doc.kind)) continue;
      const current = byKind.get(doc.kind);
      if (!current || String(doc.uploadedAt ?? "").localeCompare(String(current.uploadedAt ?? "")) > 0) {
        byKind.set(doc.kind, doc);
      }
    }
  }
  return [...byKind.values()];
}

export async function GET() {
  try {
    const auth = await resolveVendorPortalUserId();
    if (!auth.ok) {
      return NextResponse.json(
        { error: auth.status === 401 ? "Unauthorized." : "Forbidden." },
        { status: auth.status },
      );
    }

    const db = createSupabaseServiceRoleClient();
    const records = await resolveOwnVendorRecords(db, auth.userId);
    const own = records[0];
    return NextResponse.json({
      linked: records.length > 0,
      documents: mergedVendorDocuments(records),
      insuranceProvider: own?.row.insuranceProvider ?? "",
      insurancePolicyNumber: own?.row.insurancePolicyNumber ?? "",
      insuranceExpiresAt: own?.row.insuranceExpiresAt ?? "",
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to load documents.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(req: Request) {
  try {
    const auth = await resolveVendorPortalUserId();
    if (!auth.ok) {
      return NextResponse.json(
        { error: auth.status === 401 ? "Unauthorized." : "Forbidden." },
        { status: auth.status },
      );
    }

    const db = createSupabaseServiceRoleClient();
    const records = await resolveOwnVendorRecords(db, auth.userId);
    if (records.length === 0) {
      return NextResponse.json({ error: "No linked manager found for this vendor account." }, { status: 400 });
    }

    const body = (await req.json()) as {
      insuranceProvider?: string;
      insurancePolicyNumber?: string;
      insuranceExpiresAt?: string;
      removeKind?: string;
      documents?: VendorDocumentRecord[];
    };

    let vendorDocuments = mergedVendorDocuments(records);
    if (typeof body.removeKind === "string" && isVendorDocumentKind(body.removeKind)) {
      vendorDocuments = removeVendorDocument(vendorDocuments, body.removeKind as VendorDocumentKind);
    }
    if (Array.isArray(body.documents)) {
      const incoming = body.documents.filter(Boolean);
      if (!incoming.every((d) => isStoredVendorDocument(auth.userId, d))) {
        return NextResponse.json({ error: "Documents must be uploaded through PropLane first." }, { status: 400 });
      }
      vendorDocuments = incoming;
    }

    const now = new Date().toISOString();
    for (const own of records) {
      const nextRow: ManagerVendorRow = {
        ...own.row,
        id: own.id,
        managerUserId: own.managerUserId,
        insuranceProvider:
          body.insuranceProvider !== undefined ? body.insuranceProvider.trim() : own.row.insuranceProvider,
        insurancePolicyNumber:
          body.insurancePolicyNumber !== undefined
            ? body.insurancePolicyNumber.trim()
            : own.row.insurancePolicyNumber,
        insuranceExpiresAt:
          body.insuranceExpiresAt !== undefined ? body.insuranceExpiresAt.trim() : own.row.insuranceExpiresAt,
        vendorDocuments,
        updatedAt: now,
      };

      const { error } = await db
        .from("manager_vendor_records")
        .update({ row_data: nextRow, updated_at: now })
        .eq("id", own.id);

      if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    }
    return NextResponse.json({
      documents: vendorDocuments,
      insuranceProvider: body.insuranceProvider?.trim() ?? records[0]?.row.insuranceProvider ?? "",
      insurancePolicyNumber: body.insurancePolicyNumber?.trim() ?? records[0]?.row.insurancePolicyNumber ?? "",
      insuranceExpiresAt: body.insuranceExpiresAt?.trim() ?? records[0]?.row.insuranceExpiresAt ?? "",
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to save documents.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
