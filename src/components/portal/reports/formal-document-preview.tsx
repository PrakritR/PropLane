"use client";

import { Fragment } from "react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import type { OccupancyReport, PropertyRentReceiptDocument, RentReceiptDocument } from "@/lib/reports/formal-documents/spec";
import type { ReportResult } from "@/lib/reports/types";

function DocumentPaper({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      data-surface="light"
      className={`mx-auto w-full max-w-[820px] rounded-xl border border-border bg-white text-[#1a1a1a] shadow-[0_8px_30px_rgba(15,23,42,0.08)] ${className}`}
      style={{ fontFamily: "Georgia, 'Times New Roman', serif" }}
    >
      {children}
    </div>
  );
}

function DocHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="border-b border-[#e5e7eb] px-8 py-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-[#64748b]" style={{ fontFamily: "system-ui, sans-serif" }}>
            PropLane Property Management
          </p>
          <h2 className="mt-1 text-2xl font-bold tracking-tight text-[#0f172a]">{title}</h2>
          {subtitle ? (
            <p className="mt-1 text-sm text-[#64748b]" style={{ fontFamily: "system-ui, sans-serif" }}>
              {subtitle}
            </p>
          ) : null}
        </div>
        <div className="shrink-0 text-right text-xs text-[#64748b]" style={{ fontFamily: "system-ui, sans-serif" }}>
          <p>Official record</p>
          <p className="mt-0.5 font-medium text-[#334155]">{new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" })}</p>
        </div>
      </div>
    </div>
  );
}

function DocFooter({ certification }: { certification: string }) {
  return (
    <div className="border-t border-[#e5e7eb] px-8 py-5">
      <p className="text-[11px] leading-relaxed text-[#64748b]" style={{ fontFamily: "system-ui, sans-serif" }}>
        {certification}
      </p>
      <div className="mt-6 grid gap-8 sm:grid-cols-2">
        <div>
          <div className="border-b border-[#94a3b8] pb-1" />
          <p className="mt-1 text-xs text-[#64748b]" style={{ fontFamily: "system-ui, sans-serif" }}>
            Authorized signature
          </p>
        </div>
        <div>
          <div className="border-b border-[#94a3b8] pb-1" />
          <p className="mt-1 text-xs text-[#64748b]" style={{ fontFamily: "system-ui, sans-serif" }}>
            Date
          </p>
        </div>
      </div>
    </div>
  );
}

function InfoBlock({ label, lines }: { label: string; lines: string[] }) {
  return (
    <div className="rounded-lg border border-[#e5e7eb] bg-[#f8fafc] px-4 py-3">
      <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-[#64748b]" style={{ fontFamily: "system-ui, sans-serif" }}>
        {label}
      </p>
      {lines.filter(Boolean).map((line) => (
        <p key={line} className="mt-1 text-sm leading-snug text-[#0f172a]">
          {line}
        </p>
      ))}
    </div>
  );
}

export function RentReceiptDocumentView({ doc }: { doc: RentReceiptDocument }) {
  return (
    <DocumentPaper className="mb-6">
      <DocHeader title="Rent Receipt" subtitle={`Receipt # ${doc.receiptNumber}`} />
      <div className="space-y-5 px-8 py-6">
        <div className="grid gap-4 sm:grid-cols-2">
          <InfoBlock label="Received by (landlord / property manager)" lines={[doc.landlordName, ...doc.landlordAddress.split("\n")]} />
          <InfoBlock label="Paid by (resident)" lines={[doc.tenantName, doc.tenantEmail]} />
        </div>
        <InfoBlock
          label="Rental property"
          lines={[`${doc.propertyLabel}${doc.unitLabel && doc.unitLabel !== "—" ? ` · Unit ${doc.unitLabel}` : ""}`, doc.propertyAddress]}
        />

        <div className="overflow-hidden rounded-lg border border-[#e5e7eb]">
          <div className="max-w-full overflow-x-auto">
          <table className="w-full min-w-max border-collapse text-sm" style={{ fontFamily: "system-ui, sans-serif" }}>
            <tbody>
              <tr className="border-b border-[#e5e7eb] bg-[#f8fafc]">
                <td className="px-4 py-2.5 font-semibold text-[#475569]">Payment date</td>
                <td className="px-4 py-2.5 text-[#0f172a]">{doc.paymentDate}</td>
              </tr>
              <tr className="border-b border-[#e5e7eb]">
                <td className="px-4 py-2.5 font-semibold text-[#475569]">Amount received</td>
                <td className="px-4 py-2.5 text-lg font-bold text-[#0f172a]">{doc.amount}</td>
              </tr>
              <tr className="border-b border-[#e5e7eb]">
                <td className="px-4 py-2.5 font-semibold text-[#475569]">Payment method</td>
                <td className="px-4 py-2.5 text-[#0f172a]">{doc.paymentMethod}</td>
              </tr>
              <tr className="border-b border-[#e5e7eb]">
                <td className="px-4 py-2.5 font-semibold text-[#475569]">Period / description</td>
                <td className="px-4 py-2.5 text-[#0f172a]">{doc.periodCovered}</td>
              </tr>
              <tr>
                <td className="px-4 py-2.5 font-semibold text-[#475569]">Category</td>
                <td className="px-4 py-2.5 text-[#0f172a]">{doc.category}</td>
              </tr>
            </tbody>
          </table>
          </div>
        </div>

        <p className="text-sm leading-relaxed text-[#334155]">
          I, <strong>{doc.landlordName}</strong>, acknowledge receipt of <strong>{doc.amount}</strong> from{" "}
          <strong>{doc.tenantName}</strong> for the rental property described above. This receipt constitutes proof of payment
          for the period stated and should be retained for tax and legal records.
        </p>
      </div>
      <DocFooter certification="This document is an official payment receipt generated from PropLane property records. Retain for your records. Consult a tax or legal advisor for compliance in your jurisdiction." />
    </DocumentPaper>
  );
}

export function PropertyRentReceiptDocumentView({ doc }: { doc: PropertyRentReceiptDocument }) {
  return (
    <DocumentPaper className="mb-6">
      <DocHeader
        title="Property Income & Occupancy Statement"
        subtitle={`${doc.propertyLabel} · ${doc.periodFrom} to ${doc.periodTo}`}
      />
      <div className="space-y-5 px-8 py-6">
        <InfoBlock label="Property owner / manager" lines={[doc.landlordName, ...doc.landlordAddress.split("\n")]} />

        <div className="grid gap-3 sm:grid-cols-4">
          {[
            { label: "Days rented", value: String(doc.daysRented), sub: undefined },
            { label: "Days available", value: String(doc.daysAvailable), sub: undefined },
            { label: "Rental use", value: `${doc.rentalUsePct}%`, sub: "Personal-use allocation" },
            { label: "Gross Rents Received", value: doc.rentCollected, sub: "Sch. E, Line 3" },
          ].map((item) => (
            <div key={item.label} className="rounded-lg border border-[#e5e7eb] bg-[#f8fafc] px-3 py-3 text-center">
              <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#64748b]" style={{ fontFamily: "system-ui, sans-serif" }}>
                {item.label}
              </p>
              <p className="mt-1 text-lg font-bold text-[#0f172a]">{item.value}</p>
              {item.sub ? (
                <p className="mt-0.5 text-[10px] text-[#94a3b8]" style={{ fontFamily: "system-ui, sans-serif" }}>
                  {item.sub}
                </p>
              ) : null}
            </div>
          ))}
        </div>

        {doc.incomeByCategory && doc.incomeByCategory.length > 0 ? (
          <div>
            <p className="mb-2 text-xs font-bold uppercase tracking-[0.14em] text-[#64748b]" style={{ fontFamily: "system-ui, sans-serif" }}>
              Income breakdown: Schedule E, Part I (Rents Received)
            </p>
            <div className="overflow-hidden rounded-lg border border-[#e5e7eb]">
              <div className="max-w-full overflow-x-auto">
              <table className="w-full min-w-max border-collapse text-sm" style={{ fontFamily: "system-ui, sans-serif" }}>
                <thead>
                  <tr className="border-b border-[#e5e7eb] bg-[#f1f5f9] text-left text-xs uppercase tracking-wide text-[#475569]">
                    <th className="px-4 py-2.5 font-semibold">Income category</th>
                    <th className="px-4 py-2.5 font-semibold">Schedule E reference</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {doc.incomeByCategory.map((row) => (
                    <tr key={row.categoryCode} className="border-b border-[#e5e7eb] last:border-0">
                      <td className="px-4 py-2.5 text-[#0f172a]">{row.label}</td>
                      <td className="px-4 py-2.5 text-[#64748b]" style={{ fontFamily: "system-ui, sans-serif" }}>{row.scheduleERef} · Rents Received</td>
                      <td className="px-4 py-2.5 text-right tabular-nums font-medium text-[#0f172a]">{row.amount}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-[#f0fdf4] font-semibold">
                    <td className="px-4 py-2.5 text-[#0f172a]" colSpan={2}>
                      Total Gross Income (Sch. E, Line 3, Rents Received)
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-[#0f172a]">{doc.rentCollected}</td>
                  </tr>
                </tfoot>
              </table>
              </div>
            </div>
          </div>
        ) : null}

        <div>
          <p className="mb-2 text-xs font-bold uppercase tracking-[0.14em] text-[#64748b]" style={{ fontFamily: "system-ui, sans-serif" }}>
            Unit detail
          </p>
          <div className="overflow-hidden rounded-lg border border-[#e5e7eb]">
            <div className="max-w-full overflow-x-auto">
            <table className="w-full min-w-max border-collapse text-sm" style={{ fontFamily: "system-ui, sans-serif" }}>
              <thead>
                <tr className="border-b border-[#e5e7eb] bg-[#f1f5f9] text-left text-xs uppercase tracking-wide text-[#475569]">
                  <th className="px-4 py-2.5 font-semibold">Unit</th>
                  <th className="px-4 py-2.5 font-semibold">Resident</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Days rented / available</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Gross rents received</th>
                  <th className="px-4 py-2.5 text-right font-semibold">Receipts</th>
                </tr>
              </thead>
              <tbody>
                {doc.units.map((unit) => (
                  <tr key={`${unit.unit}-${unit.resident}`} className="border-b border-[#e5e7eb] last:border-0">
                    <td className="px-4 py-2.5 text-[#0f172a]">{unit.unit}</td>
                    <td className="px-4 py-2.5 text-[#0f172a]">{unit.resident}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-[#0f172a]">
                      {unit.daysRented} / {unit.daysAvailable}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums font-medium text-[#0f172a]">{unit.rentCollected}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-[#0f172a]">{unit.receiptCount}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-[#f8fafc] font-semibold">
                  <td className="px-4 py-2.5 text-[#0f172a]" colSpan={2}>
                    Total ({doc.receiptCount} payment{doc.receiptCount === 1 ? "" : "s"})
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-[#0f172a]">{doc.daysRented}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-[#0f172a]">{doc.rentCollected}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-[#0f172a]">{doc.receiptCount}</td>
                </tr>
              </tfoot>
            </table>
            </div>
          </div>
        </div>

        <p className="text-xs leading-relaxed text-[#64748b]" style={{ fontFamily: "system-ui, sans-serif" }}>
          All rental income, including base rent, late fees, pet rent, and other charges, is reported on IRS Schedule E
          (Form 1040), Part I, Line 3 (Rents Received). Days rented and rental-use percentage support the personal-use
          allocation calculation on Schedule E, Part I.
        </p>
      </div>
      <DocFooter certification="This statement is prepared for Schedule E (Form 1040) recordkeeping purposes. Rent received, days rented, and occupancy data support Part I of Schedule E. Retain this document with your tax records and consult your tax advisor for guidance specific to your situation." />
    </DocumentPaper>
  );
}

export function FinancialReportDocumentView({ report }: { report: ReportResult }) {
  const period =
    report.meta?.from && report.meta?.to ? `${String(report.meta.from)} to ${String(report.meta.to)}` : undefined;
  const scope =
    report.meta?.scopeLabel && String(report.meta.scopeLabel) !== "All properties"
      ? String(report.meta.scopeLabel)
      : undefined;
  const subtitle = [period ? `Reporting period: ${period}` : null, scope ? `Scope: ${scope}` : null]
    .filter(Boolean)
    .join(" · ");

  // Detect section grouping: if rows have a "section" column, render section headers
  const hasSections = report.columns.some((c) => c.key === "section");
  const dataColumns = hasSections ? report.columns.filter((c) => c.key !== "section") : report.columns;

  // Build grouped rows: [{sectionLabel, rows}]
  type GroupedSection = { label: string; rows: typeof report.rows };
  const sections: GroupedSection[] = [];
  if (hasSections) {
    for (const row of report.rows) {
      const label = String(row.section ?? "");
      const isTotal = row._isTotal === true || row._isTotal === "true";
      if (isTotal) {
        // Net total rows get their own pseudo-section with empty label
        sections.push({ label: "", rows: [row] });
        continue;
      }
      const last = sections[sections.length - 1];
      if (!last || last.label !== label) {
        sections.push({ label, rows: [row] });
      } else {
        last.rows.push(row);
      }
    }
  }

  return (
    <DocumentPaper>
      <DocHeader title={report.title} subtitle={subtitle || undefined} />
      <div className="px-8 py-6">
        <div className="overflow-hidden rounded-lg border border-[#e5e7eb]">
          <div className="max-w-full overflow-x-auto">
          <table className="w-full min-w-max border-collapse text-sm" style={{ fontFamily: "system-ui, sans-serif" }}>
            <thead>
              <tr className="border-b border-[#e5e7eb] bg-[#f1f5f9] text-left text-xs uppercase tracking-wide text-[#475569]">
                {dataColumns.map((col) => (
                  <th
                    key={col.key}
                    className={`px-4 py-2.5 font-semibold ${col.align === "right" ? "text-right" : "text-left"}`}
                  >
                    {col.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {hasSections
                ? sections.map((section, si) => (
                    <Fragment key={`${section.label}-${si}`}>
                      {section.label ? (
                        <tr className="bg-[#f8fafc]">
                          <td
                            colSpan={dataColumns.length}
                            className="border-b border-t border-[#e5e7eb] px-4 py-2 text-[11px] font-bold uppercase tracking-[0.12em] text-[#475569]"
                            style={{ fontFamily: "system-ui, sans-serif" }}
                          >
                            {section.label}
                          </td>
                        </tr>
                      ) : null}
                      {section.rows.map((row, idx) => {
                        const isTotal = row._isTotal === true || row._isTotal === "true";
                        return (
                          <tr
                            key={idx}
                            className={`border-b border-[#e5e7eb] last:border-0 ${isTotal ? "bg-[#f0fdf4] font-bold" : ""}`}
                          >
                            {dataColumns.map((col) => (
                              <td
                                key={col.key}
                                className={`px-4 py-2.5 text-[#0f172a] ${col.align === "right" ? "text-right tabular-nums" : "text-left"}`}
                              >
                                {String(row[col.key] ?? "—")}
                              </td>
                            ))}
                          </tr>
                        );
                      })}
                    </Fragment>
                  ))
                : report.rows.map((row, idx) => (
                    <tr key={idx} className="border-b border-[#e5e7eb] last:border-0">
                      {dataColumns.map((col) => (
                        <td
                          key={col.key}
                          className={`px-4 py-2.5 text-[#0f172a] ${col.align === "right" ? "text-right tabular-nums" : "text-left"}`}
                        >
                          {String(row[col.key] ?? "—")}
                        </td>
                      ))}
                    </tr>
                  ))}
            </tbody>
            {report.totals ? (
              <tfoot>
                <tr className="bg-[#f8fafc] font-semibold">
                  {dataColumns.map((col) => (
                    <td
                      key={col.key}
                      className={`px-4 py-2.5 text-[#0f172a] ${col.align === "right" ? "text-right tabular-nums" : "text-left"}`}
                    >
                      {String(report.totals![col.key] ?? "")}
                    </td>
                  ))}
                </tr>
              </tfoot>
            ) : null}
          </table>
          </div>
        </div>
      </div>
      <DocFooter certification="Prepared from PropLane ledger records. This report is provided for property management and Schedule E (Form 1040) tax record-keeping. Verify totals against bank statements and consult your tax advisor." />
    </DocumentPaper>
  );
}

export function OccupancyDocumentView({ report }: { report: OccupancyReport }) {
  const period = `${report.periodFrom} to ${report.periodTo}`;
  return (
    <DocumentPaper>
      <DocHeader title="Occupancy Report" subtitle={`Portfolio · ${period}`} />
      <div className="space-y-6 px-8 py-6">
        <InfoBlock label="Property owner / manager" lines={[report.landlordName, ...report.landlordAddress.split("\n")]} />

        <div className="grid gap-3 sm:grid-cols-3">
          {[
            { label: "Total units", value: String(report.totalUnits) },
            { label: "Occupied units", value: `${report.occupiedUnits} / ${report.totalUnits}` },
            { label: "Portfolio occupancy", value: `${report.portfolioOccupancyPct}%` },
          ].map((item) => (
            <div key={item.label} className="rounded-lg border border-[#e5e7eb] bg-[#f8fafc] px-3 py-3 text-center">
              <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#64748b]" style={{ fontFamily: "system-ui, sans-serif" }}>
                {item.label}
              </p>
              <p className="mt-1 text-xl font-bold text-[#0f172a]">{item.value}</p>
            </div>
          ))}
        </div>

        {report.properties.map((prop) => (
          <div key={prop.propertyId}>
            <div className="mb-2 flex items-center justify-between gap-4">
              <p className="text-sm font-bold text-[#0f172a]" style={{ fontFamily: "system-ui, sans-serif" }}>
                {prop.propertyLabel}
              </p>
              <div className="flex shrink-0 gap-4 text-xs text-[#64748b]" style={{ fontFamily: "system-ui, sans-serif" }}>
                <span>{prop.occupiedUnits}/{prop.totalUnits} units occupied</span>
                <span className="font-semibold text-[#0f172a]">{prop.occupancyPct}% occupancy</span>
              </div>
            </div>
            <div className="overflow-hidden rounded-lg border border-[#e5e7eb]">
              <div className="max-w-full overflow-x-auto">
              <table className="w-full min-w-max border-collapse text-sm" style={{ fontFamily: "system-ui, sans-serif" }}>
                <thead>
                  <tr className="border-b border-[#e5e7eb] bg-[#f1f5f9] text-left text-xs uppercase tracking-wide text-[#475569]">
                    <th className="px-4 py-2.5 font-semibold">Unit</th>
                    <th className="px-4 py-2.5 font-semibold">Resident</th>
                    <th className="px-4 py-2.5 font-semibold">Lease start</th>
                    <th className="px-4 py-2.5 font-semibold">Lease end</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Days rented</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Days avail.</th>
                    <th className="px-4 py-2.5 text-right font-semibold">Occupancy %</th>
                    <th className="px-4 py-2.5 font-semibold">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {prop.units.map((unit) => (
                    <tr key={`${unit.unit}-${unit.resident}`} className="border-b border-[#e5e7eb] last:border-0">
                      <td className="px-4 py-2.5 font-medium text-[#0f172a]">{unit.unit}</td>
                      <td className="px-4 py-2.5 text-[#0f172a]">{unit.resident}</td>
                      <td className="px-4 py-2.5 tabular-nums text-[#64748b]">{unit.leaseStart}</td>
                      <td className="px-4 py-2.5 tabular-nums text-[#64748b]">{unit.leaseEnd}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-[#0f172a]">{unit.daysRented}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-[#0f172a]">{unit.daysAvailable}</td>
                      <td className="px-4 py-2.5 text-right tabular-nums font-medium text-[#0f172a]">{unit.occupancyPct}%</td>
                      <td className="px-4 py-2.5">
                        <Badge tone={unit.status === "occupied" ? "confirmed" : "pending"}>
                          {unit.status === "occupied" ? "Occupied" : "Vacant"}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-[#f8fafc] font-semibold">
                    <td className="px-4 py-2.5 text-[#0f172a]" colSpan={4}>
                      Property total ({prop.totalUnits} unit{prop.totalUnits === 1 ? "" : "s"})
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-[#0f172a]">{prop.daysRented}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-[#0f172a]">{prop.daysAvailable}</td>
                    <td className="px-4 py-2.5 text-right tabular-nums text-[#0f172a]">{prop.occupancyPct}%</td>
                    <td className="px-4 py-2.5 text-xs text-[#64748b]">{prop.occupiedUnits}/{prop.totalUnits} occupied</td>
                  </tr>
                </tfoot>
              </table>
              </div>
            </div>
          </div>
        ))}

        {report.properties.length === 0 ? (
          <p className="py-6 text-center text-sm text-[#64748b]" style={{ fontFamily: "system-ui, sans-serif" }}>
            No active leases found for the selected period.
          </p>
        ) : null}

        <p className="text-xs leading-relaxed text-[#64748b]" style={{ fontFamily: "system-ui, sans-serif" }}>
          Occupancy % = days rented ÷ days available in the reporting period. Use this metric for rental-use calculations
          on IRS Schedule E and to assess property performance. Personal-use days reduce the rental-use percentage.
        </p>
      </div>
      <DocFooter certification="This occupancy report is generated from PropLane property management records and reflects active lease data for the stated period. Retain for investment analysis and tax recordkeeping. Consult a tax advisor regarding rental-use percentage calculations for Schedule E." />
    </DocumentPaper>
  );
}

export function FormalDocumentsPreview({
  propertyDocuments,
  rentReceipts,
}: {
  propertyDocuments?: PropertyRentReceiptDocument[];
  rentReceipts?: RentReceiptDocument[];
}) {
  return (
    <div className="space-y-6 rounded-2xl border border-border bg-[#eef2f7] p-4 sm:p-6">
      {propertyDocuments?.map((doc) => (
        <PropertyRentReceiptDocumentView key={doc.id} doc={doc} />
      ))}
      {rentReceipts?.map((doc) => (
        <RentReceiptDocumentView key={doc.id} doc={doc} />
      ))}
    </div>
  );
}
