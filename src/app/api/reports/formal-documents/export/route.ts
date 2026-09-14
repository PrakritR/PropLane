import { NextResponse } from "next/server";
import {
  applyFormalDocumentScope,
  queryFormalDaysRented,
  queryFormalPropertyRentReceipts,
  queryFormalRentReceipts,
} from "@/lib/reports/formal-documents/scoped-queries";
import {
  buildDaysRentedPdf,
  buildPropertyRentReceiptPdf,
  buildPropertyRentReceiptsCombinedPdf,
  buildRentReceiptPdf,
  buildRentReceiptsCombinedPdf,
} from "@/lib/reports/export/formal/rent-receipt-pdf";
import type { DocumentScope, FormalDocumentKind } from "@/lib/reports/types";
import { assertManagerFinancialsAccess, getReportsAuthContext } from "@/lib/reports/auth";
import { activeWorkspacePropertyScope } from "@/lib/workspaces/scope.server";

export const runtime = "nodejs";

function parseInclude(url: URL): string[] | undefined {
  const raw = url.searchParams.get("include");
  return raw ? raw.split(",").filter(Boolean) : undefined;
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

    const scope = (url.searchParams.get("scope") || "portfolio") as DocumentScope;
    const filters = applyFormalDocumentScope({
      // Narrowed by the viewer's active workspace, resolved server-side.
      workspacePropertyIds: await activeWorkspacePropertyScope(auth.db, auth.userId),
      scope,
      propertyId: url.searchParams.get("propertyId") || undefined,
      residentEmail: url.searchParams.get("residentEmail") || undefined,
      roomLabel: url.searchParams.get("roomLabel") || undefined,
      from: url.searchParams.get("from") || undefined,
      to: url.searchParams.get("to") || undefined,
    });
    const includeFields = parseInclude(url) as never;

    if (kind === "rent_receipt") {
      const { documents } = await queryFormalRentReceipts(auth.db, auth.userId, filters);
      const ledgerId = url.searchParams.get("ledgerId");
      let pdf: Uint8Array;
      let filename: string;

      if (ledgerId) {
        const doc = documents.find((d) => d.id === ledgerId);
        if (!doc) return NextResponse.json({ error: "Receipt not found." }, { status: 404 });
        pdf = await buildRentReceiptPdf(doc, includeFields);
        filename = `${doc.receiptNumber}.pdf`;
      } else if (documents.length === 0) {
        return NextResponse.json({ error: "No receipts in range." }, { status: 404 });
      } else {
        pdf = await buildRentReceiptsCombinedPdf(documents, includeFields);
        filename = `rent-receipts-${filters.from}-${filters.to}.pdf`;
      }

      return new NextResponse(Buffer.from(pdf), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      });
    }

    if (kind === "property_rent_receipt") {
      const { documents } = await queryFormalPropertyRentReceipts(auth.db, auth.userId, filters);
      const propertyId = url.searchParams.get("propertyId");
      let pdf: Uint8Array;
      let filename: string;

      if (propertyId) {
        const doc = documents.find((d) => d.propertyId === propertyId);
        if (!doc) return NextResponse.json({ error: "Property receipt not found." }, { status: 404 });
        pdf = await buildPropertyRentReceiptPdf(doc, includeFields);
        filename = `rent-receipt-${doc.propertyLabel.replace(/\s+/g, "-").toLowerCase()}-${filters.from}-${filters.to}.pdf`;
      } else if (documents.length === 0) {
        return NextResponse.json({ error: "No property receipts in range." }, { status: 404 });
      } else {
        pdf = await buildPropertyRentReceiptsCombinedPdf(documents, includeFields);
        filename = `rent-receipts-by-property-${filters.from}-${filters.to}.pdf`;
      }

      return new NextResponse(Buffer.from(pdf), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `attachment; filename="${filename}"`,
        },
      });
    }

    const { document } = await queryFormalDaysRented(auth.db, auth.userId, filters);
    const pdf = await buildDaysRentedPdf(document, includeFields);
    const filename = `days-rented-${filters.from}-${filters.to}.pdf`;
    return new NextResponse(Buffer.from(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `attachment; filename="${filename}"`,
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
