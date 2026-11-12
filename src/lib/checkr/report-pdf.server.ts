import "server-only";

import { checkrApiFetch } from "@/lib/checkr/client";
import { checkrSkipsManagerCardCharge } from "@/lib/checkr/config";
import { fetchCheckrReportPdfBytes } from "@/lib/checkr/report-document";
import { loadCheckrSampleReportPdfBytes } from "@/lib/checkr/sample-report-pdf";
import type { ApplicationBackgroundCheck } from "@/lib/checkr/types";

/** The official Checkr report PDF for a completed check (a sample document for a simulated one). Bytes only, never a Checkr URL. */
export async function loadCheckReportPdf(check: ApplicationBackgroundCheck): Promise<ArrayBuffer | null> {
  let pdf: ArrayBuffer | null = null;
  if (!(check.simulated && checkrSkipsManagerCardCharge())) {
    pdf = await fetchCheckrReportPdfBytes(checkrApiFetch, { orderId: check.reportId, reportResourceId: check.reportResourceId });
  }
  if (!pdf && check.simulated) pdf = await loadCheckrSampleReportPdfBytes();
  return pdf;
}
