import type { DemoApplicantRow } from "@/data/demo-portal";
import { clean, escapeHtml } from "@/lib/manager-application-html";
import { leaseCss } from "@/lib/lease-templates/types";
import type { CheckrReportSnapshot } from "@/lib/checkr/types";
import { countRecordsFromSnapshot, type CheckrReportProductKey } from "@/lib/checkr/report-snapshot";
import { formatCheckrPrice } from "@/lib/checkr/packages";
import { applicantDisplayName } from "@/lib/rental-application/applicant-name";

function statCard(label: string, value: string, sub?: string): string {
  return `
<div class="stat">
  <p class="stat-label">${escapeHtml(label)}</p>
  <p class="stat-value">${escapeHtml(value)}</p>
  ${sub ? `<p class="stat-sub">${escapeHtml(sub)}</p>` : ""}
</div>`;
}

function historyRow(label: string, count: number): string {
  const text = count > 0 ? `${count} record${count === 1 ? "" : "s"} found` : "No records found";
  return `
<div class="history-row">
  <div>
    <p class="history-label">${escapeHtml(label)}</p>
    <p class="history-result">${escapeHtml(text)}</p>
  </div>
</div>`;
}

function productStatus(snapshot: CheckrReportSnapshot | undefined, key: CheckrReportProductKey): string {
  const product = snapshot?.[key];
  if (!product || typeof product !== "object") return "—";
  const status = product.status;
  if (!status) return "—";
  if (status === "clear") return "Clear";
  if (status === "consider") return "Consider";
  return status.replace(/_/g, " ");
}

/** Checkr Tenant–style inline report preview for manager/resident documents. */
export function buildCheckrTenantReportHtml(row: DemoApplicantRow): string {
  const bg = row.backgroundCheck;
  if (!bg) return "";

  const snapshot = bg.reportSnapshot;
  const applicantName = applicantDisplayName(row);
  const email = clean(row.email) || row.application?.email || "—";
  const property = clean(row.property) || "—";
  const packageLabel = bg.packageSlug.charAt(0).toUpperCase() + bg.packageSlug.slice(1);
  const creditScore = snapshot?.credit_score != null ? `${snapshot.credit_score}+` : "—";
  const estPayments =
    snapshot?.est_monthly_payments_cents != null
      ? `~${formatCheckrPrice(snapshot.est_monthly_payments_cents)}`
      : "—";
  const estIncome =
    snapshot?.est_monthly_income_cents != null
      ? formatCheckrPrice(snapshot.est_monthly_income_cents)
      : "—";

  const styles = `
${leaseCss()}
html, body { background: #0f1419; color: #e8edf2; margin: 0; font-family: system-ui, sans-serif; }
.wrap { padding: 1.25rem 1.5rem 2rem; }
.hero h1 { margin: 0; font-size: 1.75rem; font-weight: 700; }
.meta { margin-top: 0.35rem; color: #9aa8b5; font-size: 0.85rem; }
.stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 0.75rem; margin: 1.25rem 0; }
.stat { background: #1a222c; border: 1px solid #2a3544; border-radius: 12px; padding: 0.85rem 1rem; }
.stat-label { margin: 0; font-size: 0.65rem; letter-spacing: 0.12em; text-transform: uppercase; color: #8b98a8; }
.stat-value { margin: 0.35rem 0 0; font-size: 1.35rem; font-weight: 700; }
.stat-sub { margin: 0.2rem 0 0; font-size: 0.75rem; color: #8b98a8; }
.section-title { margin: 1.5rem 0 0.75rem; font-size: 0.7rem; letter-spacing: 0.16em; text-transform: uppercase; color: #8b98a8; }
.credit-box { background: #1a222c; border: 1px solid #2a3544; border-radius: 16px; padding: 1rem 1.25rem; display: flex; gap: 1.5rem; align-items: center; flex-wrap: wrap; }
.credit-score { font-size: 2.5rem; font-weight: 800; color: #f5f7fa; }
.history-row { background: #1a222c; border: 1px solid #2a3544; border-radius: 12px; padding: 1rem 1.25rem; margin-bottom: 0.65rem; }
.history-label { margin: 0; font-size: 0.7rem; letter-spacing: 0.14em; text-transform: uppercase; color: #8b98a8; }
.history-result { margin: 0.35rem 0 0; font-size: 1.1rem; font-weight: 600; }
.footnote { margin-top: 1.5rem; font-size: 0.75rem; color: #8b98a8; line-height: 1.5; }
.badge { display: inline-block; margin-left: 0.5rem; padding: 0.15rem 0.5rem; border-radius: 999px; font-size: 0.65rem; font-weight: 700; background: #243044; color: #cbd5e1; }
`;

  const body = `
<div class="wrap">
  <div class="hero">
    <h1>${escapeHtml(applicantName)}</h1>
    <p class="meta">${escapeHtml(property)} · ${escapeHtml(email)}</p>
    <p class="meta">Package: ${escapeHtml(packageLabel)}${bg.addOnProducts?.length ? ` · Add-ons: ${escapeHtml(bg.addOnProducts.join(", "))}` : ""}</p>
  </div>

  <div class="stats">
    ${statCard("Est. debt/rent payments", estPayments, "Monthly obligations")}
    ${statCard("Eviction records", String(countRecordsFromSnapshot(snapshot, "eviction_history")))}
    ${statCard("Criminal", String(countRecordsFromSnapshot(snapshot, "criminal_history")))}
    ${statCard("Sex offender registry", String(countRecordsFromSnapshot(snapshot, "sex_offender_registry")))}
    ${statCard("Global watchlist", String(countRecordsFromSnapshot(snapshot, "global_watchlist")))}
    ${snapshot?.income_verification ? statCard("Est. monthly income", estIncome) : statCard("On-time payments", "—")}
  </div>

  ${
    snapshot?.credit_report || snapshot?.credit_score
      ? `<p class="section-title">Credit report</p>
  <div class="credit-box">
    <div class="credit-score">${escapeHtml(creditScore)}</div>
    <div>
      <p class="meta">Status: ${escapeHtml(productStatus(snapshot, "credit_report"))}</p>
      <p class="meta">Est. monthly payments ${escapeHtml(estPayments)}</p>
    </div>
  </div>`
      : ""
  }

  ${
    snapshot?.identity_verification
      ? `<p class="section-title">Identity verification <span class="badge">${escapeHtml(productStatus(snapshot, "identity_verification"))}</span></p>`
      : ""
  }

  <p class="section-title">Background history</p>
  ${historyRow("Eviction history", countRecordsFromSnapshot(snapshot, "eviction_history"))}
  ${historyRow("Criminal history", countRecordsFromSnapshot(snapshot, "criminal_history"))}
  ${historyRow("Sex offender registry", countRecordsFromSnapshot(snapshot, "sex_offender_registry"))}
  ${historyRow("Global watchlist", countRecordsFromSnapshot(snapshot, "global_watchlist"))}

  <p class="footnote">Generated from Checkr Tenant screening data in PropLane. Consult the full vendor report before any adverse action (FCRA). Pass-through fees may apply on live orders.</p>
</div>`;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><title>Screening — ${escapeHtml(applicantName)}</title><style>${styles}</style></head><body>${body}</body></html>`;
}
