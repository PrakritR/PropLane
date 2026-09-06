import { depositDispositionAmounts } from "@/lib/reports/deposit-disposition-amounts";
import { NextResponse } from "next/server";
import { buildDepositDispositionPdf, type DepositDispositionLine } from "@/lib/reports/export/formal/deposit-disposition-pdf";
import { assertManagerFinancialsAccess, getReportsAuthContext } from "@/lib/reports/auth";
import { loadManagerReportDisplayContext } from "@/lib/reports/display-context";
import { centsToUsd } from "@/lib/reports/money";
import { getSecurityDepositById, type SecurityDepositDispositionType } from "@/lib/reports/security-deposits";
import type { SupabaseClient } from "@supabase/supabase-js";

export const runtime = "nodejs";

const DISPOSITION_LABELS: Record<SecurityDepositDispositionType, string> = {
  full_refund: "Full refund",
  itemized_partial: "Itemized partial",
  full_withhold: "Full withhold",
};

async function loadLandlordIdentity(db: SupabaseClient, managerUserId: string) {
  const { data } = await db
    .from("manager_tax_profiles")
    .select("legal_name, address_line1, address_line2, city, state, zip")
    .eq("manager_user_id", managerUserId)
    .maybeSingle();
  const name = data?.legal_name?.trim() || "Property manager";
  const address = [
    data?.address_line1?.trim(),
    data?.address_line2?.trim(),
    [data?.city, data?.state, data?.zip].filter(Boolean).join(", ").trim(),
  ]
    .filter(Boolean)
    .join("\n") || "—";
  return { name, address };
}

export async function GET(req: Request) {
  try {
    const auth = await getReportsAuthContext({ preferRole: "manager" });
    if (!auth) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });
    const gate = await assertManagerFinancialsAccess(auth);
    if (!gate.ok) return NextResponse.json({ error: gate.error }, { status: gate.status });

    const url = new URL(req.url);
    const depositId = url.searchParams.get("depositId")?.trim();
    if (!depositId) return NextResponse.json({ error: "depositId required." }, { status: 400 });

    const managerUserId = auth.role === "admin" ? url.searchParams.get("managerUserId")?.trim() || auth.userId : auth.userId;
    const deposit = await getSecurityDepositById(auth.db, managerUserId, depositId);
    if (!deposit) return NextResponse.json({ error: "Deposit not found." }, { status: 404 });

    const [landlord, display] = await Promise.all([
      loadLandlordIdentity(auth.db, managerUserId),
      loadManagerReportDisplayContext(auth.db, managerUserId),
    ]);

    const depositHeldCents = deposit.amountCents;
    const { deductions, priorRefundCents: historicalRefunds, withheldCents, refundCents } = depositDispositionAmounts(deposit);

    const itemization: DepositDispositionLine[] = deductions.map((item) => ({
      label: item.label,
      amount: centsToUsd(Math.max(0, Math.round(item.amountCents))),
    }));
    if (itemization.length === 0 && withheldCents > 0) {
      itemization.push({ label: "Withheld (forfeited)", amount: centsToUsd(withheldCents) });
    }

    const pdf = await buildDepositDispositionPdf({
      issueDate: deposit.dispositionDate ?? new Date().toISOString().slice(0, 10),
      landlordName: landlord.name,
      landlordAddress: landlord.address,
      residentName: display.residentLabel(deposit.residentEmail) || deposit.residentEmail,
      residentEmail: deposit.residentEmail,
      propertyLabel: display.propertyLabel(deposit.propertyId),
      unitLabel: deposit.unitLabel ?? "",
      depositReceivedDate: deposit.receivedDate,
      evidenceReferences: deductions.filter(item => item.evidence).map(item => `Inspection ${item.evidence!.inspectionId}; item ${item.evidence!.itemId}; approved bill ${item.evidence!.billId}${item.evidence!.baselineId ? `; move-in baseline ${item.evidence!.baselineId}` : ""}`),
      priorRefunds: historicalRefunds ? centsToUsd(historicalRefunds) : undefined,
      dispositionType: deposit.dispositionType ? DISPOSITION_LABELS[deposit.dispositionType] : "Pending",
      depositHeld: centsToUsd(depositHeldCents),
      itemization,
      totalWithheld: centsToUsd(withheldCents),
      refundDue: centsToUsd(refundCents),
    });

    const disposition = url.searchParams.get("disposition") === "inline" ? "inline" : "attachment";
    return new NextResponse(Buffer.from(pdf), {
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `${disposition}; filename="deposit-disposition-${depositId}.pdf"`,
      },
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Failed to export disposition statement.";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
