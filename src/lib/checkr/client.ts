/**
 * Server-side Checkr Tenant API client. Runs a rental background-check order:
 * create applicant → create property → create order → fetch report.
 *
 * Security:
 *  - The secret key is used ONLY here, server-side, as the Bearer token. It is
 *    never returned to callers, never put in an error message, and never
 *    logged.
 *  - All applicant PII is assembled and sent from the server; nothing about
 *    the request is exposed to the browser.
 *
 * Async model: Checkr orders complete asynchronously in production (the
 * sandbox completes them synchronously on creation). We support status
 * polling; a webhook receiver (`/api/webhooks/screening/checkr`) can push
 * completions instead — preferred once instant propagation matters.
 */
import {
  checkrApiBaseUrl,
  checkrApiKey,
  checkrSimulate,
} from "@/lib/checkr/config";
import type { CheckrAddOnSlug } from "@/lib/checkr/packages";
import {
  aggregateResultFromSnapshot,
  buildSimulatedReportSnapshot,
  parseCheckrReportSnapshot,
} from "@/lib/checkr/report-snapshot";
import { parseCheckrReportResourceId } from "@/lib/checkr/report-document";
import { stableHash } from "@/lib/checkr/simulate";
import type {
  CheckrApplicantInput,
  CheckrCreateResult,
  CheckrOrderOptions,
  CheckrPropertyInput,
  CheckrReport,
  CheckrReportStatus,
} from "@/lib/checkr/types";

function authHeader(): string {
  const key = checkrApiKey();
  if (!key) throw new Error("Checkr is not configured (missing CHECKR_API_KEY).");
  return `Bearer ${key}`;
}

async function checkrFetch(path: string, init?: RequestInit): Promise<Response> {
  const url = `${checkrApiBaseUrl()}${path.startsWith("/") ? path : `/${path}`}`;
  return fetch(url, {
    ...init,
    headers: {
      Authorization: authHeader(),
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

/** Extract a human-safe error message without ever echoing credentials. */
async function readError(response: Response, fallback: string): Promise<string> {
  const payload = (await response.json().catch(() => null)) as
    | { errors?: Array<{ detail?: string }> }
    | null;
  const detail = payload?.errors?.[0]?.detail;
  return detail ? `Checkr: ${detail}` : `${fallback} (${response.status}).`;
}

/** Checkr order status string -> PropLane lifecycle. Anything not clearly complete/canceled stays pending, never "complete". */
export function normalizeOrderStatus(value: unknown): CheckrReportStatus {
  const s = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (s === "complete" || s === "completed") return "complete";
  if (s === "canceled" || s === "cancelled") return "canceled";
  return "pending";
}

function aggregateReportResult(report: Record<string, unknown> | null) {
  return aggregateResultFromSnapshot(parseCheckrReportSnapshot(report));
}

async function fetchReportRaw(orderId: string): Promise<Record<string, unknown> | null> {
  const res = await checkrFetch(`/orders/${encodeURIComponent(orderId)}/report`);
  if (!res.ok) return null;
  return (await res.json()) as Record<string, unknown>;
}

function reportMetaFromRaw(raw: Record<string, unknown> | null) {
  return {
    reportSnapshot: parseCheckrReportSnapshot(raw),
    reportResourceId: parseCheckrReportResourceId(raw),
  };
}

export { checkrFetch as checkrApiFetch };

/** Create an applicant + property + order and return identifiers + initial status. */
export async function createBackgroundCheck(
  applicant: CheckrApplicantInput,
  property: CheckrPropertyInput,
  options: CheckrOrderOptions,
): Promise<CheckrCreateResult> {
  const packageSlug = options.packageSlug;
  const addOnProducts = options.addOnProducts ?? [];

  if (checkrSimulate() && !checkrApiKey()) {
    const seed = stableHash(`${applicant.email}:${applicant.ssn}`);
    const reportSnapshot = buildSimulatedReportSnapshot({
      firstName: applicant.firstName,
      lastName: applicant.lastName,
      dob: applicant.dob,
      ssn: applicant.ssn,
      packageSlug,
      addOnProducts,
    });
    const result = aggregateResultFromSnapshot(reportSnapshot);
    return {
      applicantId: `test_applicant_${seed}`,
      orderId: `test_order_${seed}`,
      packageSlug,
      addOnProducts,
      status: "pending",
      result: null,
      reportSnapshot,
      simulated: true,
    };
  }

  // 1) Applicant
  const applicantRes = await checkrFetch("/applicants", {
    method: "POST",
    body: JSON.stringify({
      applicant: {
        first_name: applicant.firstName,
        last_name: applicant.lastName,
        email: applicant.email,
        dob: applicant.dob ?? undefined,
        ssn: applicant.ssn || undefined,
        phone_number: applicant.phone || undefined,
      },
    }),
  });
  if (!applicantRes.ok) throw new Error(await readError(applicantRes, "Failed to create applicant"));
  const applicantBody = (await applicantRes.json()) as { id?: string };
  const applicantId = applicantBody.id;
  if (!applicantId) throw new Error("Checkr did not return an applicant id.");

  // 2) Property being screened for
  const propertyRes = await checkrFetch("/properties", {
    method: "POST",
    body: JSON.stringify({
      property: {
        name: property.name,
        street: property.street,
        unit: property.unit || undefined,
        city: property.city,
        state: property.state,
        zipcode: property.zipcode,
        country: "US",
      },
    }),
  });
  if (!propertyRes.ok) throw new Error(await readError(propertyRes, "Failed to create property"));
  const propertyBody = (await propertyRes.json()) as { id?: string };
  const propertyId = propertyBody.id;
  if (!propertyId) throw new Error("Checkr did not return a property id.");

  // 3) Order (self-hosted: manager already collected applicant consent).
  const orderBody: Record<string, unknown> = {
    applicant_id: applicantId,
    property_id: propertyId,
    package: packageSlug,
  };
  if (addOnProducts.length > 0) orderBody.add_on_products = addOnProducts;

  const orderRes = await checkrFetch("/orders", {
    method: "POST",
    body: JSON.stringify({ order: orderBody }),
  });
  if (!orderRes.ok) throw new Error(await readError(orderRes, "Failed to create order"));
  const order = (await orderRes.json()) as { id?: string; status?: string };
  if (!order.id) throw new Error("Checkr did not return an order id.");

  const status = normalizeOrderStatus(order.status);
  const reportRaw = status === "complete" ? await fetchReportRaw(order.id) : null;
  const { reportSnapshot, reportResourceId } = reportMetaFromRaw(reportRaw);
  const result = status === "complete" ? aggregateReportResult(reportRaw) : null;

  return {
    applicantId,
    orderId: order.id,
    packageSlug,
    addOnProducts,
    status,
    result,
    reportSnapshot,
    reportResourceId: reportResourceId ?? undefined,
    simulated: false,
  };
}

/** Fetch the current state of an order + its report. */
export async function fetchBackgroundCheckReport(
  orderId: string,
  opts?: { ssn?: string; firstName?: string; lastName?: string; dob?: string | null; packageSlug?: string; addOnProducts?: CheckrAddOnSlug[] },
): Promise<CheckrReport | null> {
  if (checkrSimulate() && !checkrApiKey()) {
    const reportSnapshot = buildSimulatedReportSnapshot({
      firstName: opts?.firstName ?? "Applicant",
      lastName: opts?.lastName ?? "Unknown",
      dob: opts?.dob ?? null,
      ssn: opts?.ssn ?? orderId,
      packageSlug: opts?.packageSlug ?? "essential",
      addOnProducts: opts?.addOnProducts,
    });
    return {
      orderId,
      status: "complete",
      result: aggregateResultFromSnapshot(reportSnapshot),
      reportSnapshot,
      simulated: true,
    };
  }

  const orderRes = await checkrFetch(`/orders/${encodeURIComponent(orderId)}`);
  if (!orderRes.ok) return null;
  const order = (await orderRes.json()) as { id?: string; status?: string };
  if (!order.id) return null;

  const status = normalizeOrderStatus(order.status);
  if (status !== "complete") return { orderId, status, result: null };

  const report = await fetchReportRaw(orderId);
  const { reportSnapshot, reportResourceId } = reportMetaFromRaw(report);
  return {
    orderId,
    status,
    result: aggregateReportResult(report),
    reportSnapshot,
    reportResourceId: reportResourceId ?? undefined,
  };
}
