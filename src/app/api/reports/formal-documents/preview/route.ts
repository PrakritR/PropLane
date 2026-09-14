import { NextResponse } from "next/server";
import {
  applyFormalDocumentScope,
  queryFormalDaysRented,
  queryFormalPropertyRentReceipts,
  queryFormalRentReceipts,
} from "@/lib/reports/formal-documents/scoped-queries";
import type { DocumentScope, FormalDocumentKind } from "@/lib/reports/types";
import { assertManagerFinancialsAccess, getReportsAuthContext } from "@/lib/reports/auth";
import { activeWorkspacePropertyScope } from "@/lib/workspaces/scope.server";

export const runtime = "nodejs";

function parseFilters(url: URL, workspacePropertyIds: string[] | null) {
  const scope = (url.searchParams.get("scope") || "portfolio") as DocumentScope;
  return applyFormalDocumentScope({
    // Narrowed by the viewer's active workspace, resolved server-side.
    workspacePropertyIds,
    scope,
    propertyId: url.searchParams.get("propertyId") || undefined,
    residentEmail: url.searchParams.get("residentEmail") || undefined,
    roomLabel: url.searchParams.get("roomLabel") || undefined,
    from: url.searchParams.get("from") || undefined,
    to: url.searchParams.get("to") || undefined,
    includeFields: url.searchParams.get("include")?.split(",").filter(Boolean) as never,
  });
}

export async function GET(req: Request) {
  try {
    const auth = await getReportsAuthContext({ preferRole: "manager" });
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const gate = await assertManagerFinancialsAccess(auth);
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

    const url = new URL(req.url);
    const kind = url.searchParams.get("kind") as FormalDocumentKind | null;
    if (!kind || !["rent_receipt", "days_rented", "property_rent_receipt"].includes(kind)) {
      return NextResponse.json(
        { error: "kind must be rent_receipt, property_rent_receipt, or days_rented." },
        { status: 400 },
      );
    }

    const filters = parseFilters(url, await activeWorkspacePropertyScope(auth.db, auth.userId));

    if (kind === "rent_receipt") {
      const { documents, preview } = await queryFormalRentReceipts(auth.db, auth.userId, filters);
      return NextResponse.json({ kind, documents, preview, scopeOptions: null });
    }

    if (kind === "property_rent_receipt") {
      const { documents, preview } = await queryFormalPropertyRentReceipts(auth.db, auth.userId, filters);
      return NextResponse.json({ kind, documents, preview, scopeOptions: null });
    }

    const { document, preview } = await queryFormalDaysRented(auth.db, auth.userId, filters);
    return NextResponse.json({ kind, document, preview });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
