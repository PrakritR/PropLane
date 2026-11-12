import "server-only";

import type Stripe from "stripe";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { DemoApplicantRow } from "@/data/demo-portal";
import { backgroundCheckStatusFromCheckr } from "@/lib/application-background-check";
import { authorizeResidentRole } from "@/lib/auth/resident-role-access";
import { loadCheckrProperty } from "@/lib/checkr/background-check";
import { createBackgroundCheck, fetchBackgroundCheckReport } from "@/lib/checkr/client";
import { backgroundCheckConfigured } from "@/lib/checkr/config";
import { checkrOrderCostCents, isCheckrAddOn, type CheckrAddOnSlug } from "@/lib/checkr/packages";
import type { ApplicationBackgroundCheck, CheckrReport } from "@/lib/checkr/types";
import { applicantIdCheckProvider } from "@/lib/resident-identity/provider";
import {
  APPLICANT_DEFAULT_PACKAGE,
  type ApplicantScreeningSettings,
} from "@/lib/screening/applicant-screening";
import { resolveApplicantScreeningSettings } from "@/lib/screening/applicant-screening-settings.server";
import {
  evaluatePreApply,
  PRE_APPLY_STEP_LABELS,
  preApplyOrderAllowed,
  resolvePreApplyPlan,
  type PreApplyEnvironment,
  type PreApplyPlan,
  type PreApplyState,
} from "@/lib/screening/preapply";
import { getStripe } from "@/lib/stripe";
import { captureTestWorkspaceEffectForUser } from "@/lib/test-workspaces/effects.server";

/** `screening_orders.application_id` for a Checkr order placed before any application exists. */
export function preApplyOrderKey(userId: string, propertyId: string): string {
  return `preapply:${userId}:${propertyId}`;
}

export const PRE_APPLY_HREF_VERIFY_ID = "/resident/profile?tab=profile#verification";

export function preApplyEnvironment(env: Record<string, string | undefined> = process.env): PreApplyEnvironment {
  const id = applicantIdCheckProvider(env);
  return { idEnabled: id.enabled, idProvider: id.provider, backgroundConfigured: backgroundCheckConfigured() };
}

export type PreApplyRecord = {
  id: string;
  applicationId: string | null;
  check: ApplicationBackgroundCheck;
};

export type PreApplyContext =
  | {
      ok: true;
      userId: string;
      email: string;
      propertyId: string;
      managerUserId: string;
      settings: ApplicantScreeningSettings;
      plan: PreApplyPlan;
    }
  | { ok: false; status: number; error: string };

/** The listing's owner and what its manager requires before applying. Fails closed on any unreadable fact. */
export async function loadPreApplyPlan(
  db: SupabaseClient,
  propertyId: string,
): Promise<
  | { ok: true; managerUserId: string; settings: ApplicantScreeningSettings; plan: PreApplyPlan }
  | { ok: false; status: number; error: string }
> {
  const { data, error } = await db
    .from("manager_property_records")
    .select("id, manager_user_id")
    .eq("id", propertyId)
    .maybeSingle();
  if (error) return { ok: false, status: 503, error: "Application requirements are unavailable." };
  const managerUserId = String(data?.manager_user_id ?? "").trim();
  if (!data || !managerUserId) return { ok: false, status: 404, error: "Property not found." };
  try {
    const { settings } = await resolveApplicantScreeningSettings(db, { managerUserId, propertyId });
    return { ok: true, managerUserId, settings, plan: resolvePreApplyPlan({ settings, env: preApplyEnvironment() }) };
  } catch {
    return { ok: false, status: 503, error: "Application requirements are unavailable." };
  }
}

/** The signed-in applicant (a resident account) and the listing they want to apply to, both re-derived server-side. */
export async function loadPreApplyContext(
  db: SupabaseClient,
  user: { id: string; email?: string | null },
  propertyId: string,
  options: { requireResident?: boolean } = { requireResident: true },
): Promise<PreApplyContext> {
  const email = user.email?.trim().toLowerCase() ?? "";
  if (!email) return { ok: false, status: 403, error: "Forbidden." };
  if (options.requireResident !== false) {
    const { data: profile, error: profileError } = await db.from("profiles").select("role").eq("id", user.id).maybeSingle();
    if (profileError || !(await authorizeResidentRole(db, { userId: user.id, legacyRole: profile?.role }))) {
      return { ok: false, status: 403, error: "Forbidden." };
    }
  }
  const loaded = await loadPreApplyPlan(db, propertyId);
  if (!loaded.ok) return loaded;
  return { userId: user.id, email, propertyId, ...loaded };
}

export async function loadPreApplyRecord(
  db: SupabaseClient,
  userId: string,
  propertyId: string,
): Promise<{ error: boolean; record: PreApplyRecord | null }> {
  const { data, error } = await db
    .from("applicant_preapply_checks")
    .select("id, application_id, check_data")
    .eq("resident_user_id", userId)
    .eq("property_id", propertyId)
    .maybeSingle();
  if (error) return { error: true, record: null };
  if (!data?.check_data) return { error: false, record: null };
  return {
    error: false,
    record: {
      id: String(data.id),
      applicationId: data.application_id ? String(data.application_id) : null,
      check: data.check_data as ApplicationBackgroundCheck,
    },
  };
}

async function savePreApplyRecord(
  db: SupabaseClient,
  input: { userId: string; propertyId: string; managerUserId: string; check: ApplicationBackgroundCheck },
): Promise<void> {
  const { error } = await db.from("applicant_preapply_checks").upsert(
    {
      resident_user_id: input.userId,
      property_id: input.propertyId,
      manager_user_id: input.managerUserId,
      check_data: input.check,
      authorized_at: input.check.authorization?.authorizedAt ?? null,
      disclosure_version: input.check.authorization?.disclosureVersion ?? null,
      stripe_checkout_session_id: input.check.stripeCheckoutSessionId ?? null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "resident_user_id,property_id" },
  );
  if (error) throw new Error(error.message);
}

async function upsertPreApplyOrder(
  db: SupabaseClient,
  input: { applicationId: string; managerUserId: string; check: ApplicationBackgroundCheck },
): Promise<void> {
  const { error } = await db.from("screening_orders").upsert(
    {
      application_id: input.applicationId,
      manager_user_id: input.managerUserId,
      provider: input.check.provider,
      external_order_id: input.check.reportId,
      status: input.check.status,
      row_data: input.check,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "provider,external_order_id" },
  );
  if (error) throw new Error(error.message);
}

/** Checkr redelivers events and a completed check never goes back: the same merge rule as the application row. */
export function mergeReportIntoCheck(
  current: ApplicationBackgroundCheck,
  report: Pick<CheckrReport, "status" | "result" | "reportSnapshot" | "reportResourceId">,
): ApplicationBackgroundCheck | null {
  if (current.status === "complete" && report.status !== "complete") return null;
  if (current.status === "complete" && report.status === "complete" && current.result === report.result && current.completedAt) {
    return null;
  }
  return {
    ...current,
    status: report.status,
    result: report.result,
    reportSnapshot: report.reportSnapshot ?? current.reportSnapshot,
    reportResourceId: report.reportResourceId ?? current.reportResourceId,
    completedAt: report.status === "complete" ? (current.completedAt ?? new Date().toISOString()) : current.completedAt,
  };
}

/**
 * A Checkr webhook for an order the applicant placed before applying. Updates the pre-apply record whenever one holds
 * that order (also after it was stamped onto an application). Returns whether any record held it.
 */
export async function applyPreApplyCheckReport(
  db: SupabaseClient,
  orderId: string,
  report: Pick<CheckrReport, "status" | "result" | "reportSnapshot" | "reportResourceId">,
): Promise<boolean> {
  const { data, error } = await db
    .from("applicant_preapply_checks")
    .select("id, resident_user_id, property_id, manager_user_id, check_data")
    .eq("check_data->>reportId", orderId)
    .maybeSingle();
  if (error || !data?.check_data) return false;
  const merged = mergeReportIntoCheck(data.check_data as ApplicationBackgroundCheck, report);
  if (!merged) return true;
  await savePreApplyRecord(db, {
    userId: String(data.resident_user_id),
    propertyId: String(data.property_id),
    managerUserId: String(data.manager_user_id ?? ""),
    check: merged,
  });
  return true;
}

async function personaVerified(db: SupabaseClient, userId: string): Promise<boolean> {
  try {
    const { data, error } = await db
      .from("resident_identity_subjects")
      .select("status, provider_decision, verified_at")
      .eq("resident_user_id", userId)
      .maybeSingle();
    if (error || !data) return false;
    return (
      data.status === "approved" &&
      data.provider_decision === "approved" &&
      Boolean(data.verified_at) &&
      Number.isFinite(Date.parse(data.verified_at)) &&
      Date.parse(data.verified_at) <= Date.now()
    );
  } catch {
    return false;
  }
}

async function refreshPendingCheck(
  db: SupabaseClient,
  ctx: { userId: string; propertyId: string; managerUserId: string },
  check: ApplicationBackgroundCheck,
): Promise<ApplicationBackgroundCheck> {
  if (check.status !== "pending") return check;
  try {
    const report = await fetchBackgroundCheckReport(check.reportId, {
      ssn: "",
      packageSlug: check.packageSlug,
      addOnProducts: check.addOnProducts,
    });
    if (!report) return check;
    const merged = mergeReportIntoCheck(check, report);
    if (!merged) return check;
    await savePreApplyRecord(db, { ...ctx, check: merged });
    await upsertPreApplyOrder(db, {
      applicationId: preApplyOrderKey(ctx.userId, ctx.propertyId),
      managerUserId: ctx.managerUserId,
      check: merged,
    }).catch(() => undefined);
    return merged;
  } catch {
    // A provider read that fails leaves the check pending; the webhook or the next visit completes it.
    return check;
  }
}

export type PreApplyView = {
  state: PreApplyState;
  plan: PreApplyPlan;
  record: PreApplyRecord | null;
  /** True when a new Checkr order may be paid for right now. */
  orderAllowed: boolean;
};

/** One read for the status route, the checkout route and the submit gate. */
export async function resolvePreApplyView(
  db: SupabaseClient,
  ctx: Extract<PreApplyContext, { ok: true }>,
): Promise<{ ok: true; view: PreApplyView } | { ok: false; status: number; error: string }> {
  if (!ctx.plan.verifyId.required && !ctx.plan.backgroundCheck.required) {
    return {
      ok: true,
      view: { state: evaluatePreApply({ plan: ctx.plan, check: null, personaVerified: false }), plan: ctx.plan, record: null, orderAllowed: false },
    };
  }
  const loaded = await loadPreApplyRecord(db, ctx.userId, ctx.propertyId);
  if (loaded.error) return { ok: false, status: 503, error: "Application requirements are unavailable." };
  let record = loaded.record;
  if (record && record.check.status === "pending") {
    const check = await refreshPendingCheck(db, ctx, record.check);
    record = { ...record, check };
  }
  const persona = ctx.plan.verifyId.required && ctx.plan.verifyId.provider === "persona"
    ? await personaVerified(db, ctx.userId)
    : false;
  const state = evaluatePreApply({ plan: ctx.plan, check: record?.check ?? null, personaVerified: persona });
  return { ok: true, view: { state, plan: ctx.plan, record, orderAllowed: preApplyOrderAllowed(ctx.plan, record?.check ?? null) } };
}

function splitName(full: string | null | undefined, email: string): { firstName: string; lastName: string } {
  const parts = (full ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: email.split("@")[0] || "Applicant", lastName: "Unknown" };
  return { firstName: parts[0]!, lastName: parts.length > 1 ? parts[parts.length - 1]! : "Unknown" };
}

export type PlacePreApplyOrderResult =
  | { ok: true; check: ApplicationBackgroundCheck }
  | { ok: false; status: number; error: string; code?: string };

/**
 * Place the Checkr order for an applicant who is not applying yet: their account's name and email, the listing's
 * address, the applicant's FCRA authorization. Starter is the cheapest orderable, and the ID add-on rides it when the
 * plan uses Checkr for Verify ID. Nothing is ordered without the authorization, and a provider failure after payment
 * refunds the payment.
 */
export async function placePreApplyOrder(
  db: SupabaseClient,
  input: {
    userId: string;
    email: string;
    propertyId: string;
    managerUserId: string;
    addOnProducts: CheckrAddOnSlug[];
    authorization: NonNullable<ApplicationBackgroundCheck["authorization"]>;
    prepaid?: { checkoutSessionId: string; paymentIntentId?: string };
  },
): Promise<PlacePreApplyOrderResult> {
  const { data: profile } = await db.from("profiles").select("full_name").eq("id", input.userId).maybeSingle();
  const names = splitName(profile?.full_name as string | null | undefined, input.email);
  const property = await loadCheckrProperty(db, input.propertyId);
  const packageSlug = APPLICANT_DEFAULT_PACKAGE;

  let created;
  try {
    created = await createBackgroundCheck(
      { ...names, email: input.email, dob: null, ssn: "" },
      property,
      { packageSlug, addOnProducts: input.addOnProducts },
    );
  } catch (e) {
    const providerError = e instanceof Error ? e.message : "Checkr request failed.";
    if (input.prepaid?.paymentIntentId) {
      try {
        await getStripe().refunds.create({ payment_intent: input.prepaid.paymentIntentId, reason: "requested_by_customer" });
      } catch (refundError) {
        console.error("pre-apply screening: charge not refunded after order-creation failure", {
          propertyId: input.propertyId,
          paymentIntentId: input.prepaid.paymentIntentId,
          providerError,
          refundError: refundError instanceof Error ? refundError.message : String(refundError),
        });
      }
    }
    return { ok: false, status: 502, error: providerError, code: "provider_error" };
  }

  const now = new Date().toISOString();
  const check: ApplicationBackgroundCheck = {
    provider: "checkr",
    candidateId: created.applicantId,
    reportId: created.orderId,
    packageSlug: created.packageSlug,
    addOnProducts: created.addOnProducts.length > 0 ? created.addOnProducts : undefined,
    status: created.status,
    result: created.result,
    reportSnapshot: created.reportSnapshot,
    reportResourceId: created.reportResourceId,
    orderedAt: now,
    completedAt: created.status === "complete" ? now : undefined,
    simulated: created.simulated || undefined,
    costCents: checkrOrderCostCents(created.packageSlug, created.addOnProducts),
    stripePaymentIntentId: input.prepaid?.paymentIntentId,
    stripeCheckoutSessionId: input.prepaid?.checkoutSessionId,
    payer: "applicant",
    authorization: input.authorization,
  };
  await savePreApplyRecord(db, { userId: input.userId, propertyId: input.propertyId, managerUserId: input.managerUserId, check });
  await upsertPreApplyOrder(db, {
    applicationId: preApplyOrderKey(input.userId, input.propertyId),
    managerUserId: input.managerUserId,
    check,
  });
  return { ok: true, check };
}

export function isPreApplySession(session: Pick<Stripe.Checkout.Session, "metadata">): boolean {
  return session.metadata?.preapply === "1";
}

async function waitForSessionRecord(
  db: SupabaseClient,
  sessionId: string,
  maxAttempts = 15,
  delayMs = 400,
): Promise<ApplicationBackgroundCheck | null> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { data } = await db
      .from("applicant_preapply_checks")
      .select("check_data")
      .eq("stripe_checkout_session_id", sessionId)
      .maybeSingle();
    if (data?.check_data) return data.check_data as ApplicationBackgroundCheck;
    if (attempt < maxAttempts - 1) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return null;
}

/**
 * Fulfil a paid pre-apply Checkout session: place the Checkr order. Everything is read from the session metadata our
 * own checkout route wrote, then re-verified against stored state (the listing's owner, the live plan). Idempotent on
 * the session id (webhook retries and `checkout-verify` race on one claim), and a paid session that can never be
 * ordered is refunded, never silently kept.
 */
export async function fulfillPreApplyFromSession(
  db: SupabaseClient,
  session: Stripe.Checkout.Session,
): Promise<PlacePreApplyOrderResult | { ok: true; check: null; skipped: true }> {
  if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") {
    return { ok: false, status: 409, error: "Payment is not completed yet.", code: "unpaid" };
  }
  const userId = session.metadata?.payer_user_id?.trim() ?? "";
  const propertyId = session.metadata?.property_id?.trim() ?? "";
  const claimedManager = session.metadata?.manager_user_id?.trim() ?? "";
  const authorizedAt = session.metadata?.fcra_authorized_at?.trim() ?? "";
  const disclosureVersion = session.metadata?.fcra_disclosure_version?.trim() ?? "";
  if (!userId || !propertyId || !authorizedAt || !disclosureVersion || session.client_reference_id !== userId) {
    console.error("[stripe webhook] pre-apply screening checkout missing metadata", { sessionId: session.id });
    return { ok: false, status: 400, error: "Checkout session is missing screening metadata." };
  }
  const paymentIntentId = typeof session.payment_intent === "string" ? session.payment_intent : session.payment_intent?.id;
  const refund = async () => {
    if (!paymentIntentId) return;
    try {
      await getStripe().refunds.create({ payment_intent: paymentIntentId, reason: "requested_by_customer" });
    } catch (refundError) {
      console.error("[stripe webhook] pre-apply screening charge not refunded", {
        sessionId: session.id,
        paymentIntentId,
        refundError: refundError instanceof Error ? refundError.message : String(refundError),
      });
    }
  };

  const loaded = await loadPreApplyPlan(db, propertyId);
  if (!loaded.ok) throw new Error("Screening ownership could not be verified.");
  if (loaded.managerUserId !== claimedManager) throw new Error("Screening ownership could not be verified.");

  if (
    (await captureTestWorkspaceEffectForUser({
      userId: loaded.managerUserId,
      kind: "payment",
      summary: "Pre-apply screening fulfillment was refused for a test workspace.",
      metadata: { operation: "preapply_screening_fulfillment" },
      db,
    })).captured
  ) {
    return { ok: true, check: null, skipped: true };
  }

  const existing = await loadPreApplyRecord(db, userId, propertyId);
  if (existing.error) throw new Error("Screening could not be read.");
  if (existing.record?.check.stripeCheckoutSessionId === session.id) return { ok: true, check: existing.record.check };

  // One worker places the order for a paid session; the other waits for its result.
  const claim = await db.from("screening_orders").insert({
    application_id: preApplyOrderKey(userId, propertyId),
    manager_user_id: loaded.managerUserId,
    provider: "stripe_checkout",
    external_order_id: session.id,
    status: "processing",
    row_data: { checkoutSessionId: session.id },
  });
  if (claim.error) {
    if (claim.error.code === "23505") {
      const placed = await waitForSessionRecord(db, session.id);
      if (placed) return { ok: true, check: placed };
      return { ok: false, status: 409, error: "A background check is already being placed for this payment.", code: "in_progress" };
    }
    throw new Error(claim.error.message);
  }

  // A second paid session for what a live order already covers is refunded, never ordered twice.
  if (!preApplyOrderAllowed(loaded.plan, existing.record?.check ?? null)) {
    await refund();
    return { ok: false, status: 409, error: "This listing's requirements are already covered.", code: "already_screened" };
  }

  const profile = await db.from("profiles").select("email").eq("id", userId).maybeSingle();
  const email = String(profile.data?.email ?? session.customer_email ?? "").trim().toLowerCase();
  const addOnProducts = (session.metadata?.add_on_products ?? "")
    .split(",")
    .map((slug) => slug.trim())
    .filter(isCheckrAddOn);
  const placed = await placePreApplyOrder(db, {
    userId,
    email,
    propertyId,
    managerUserId: loaded.managerUserId,
    addOnProducts,
    authorization: { authorizedAt, disclosureVersion },
    prepaid: { checkoutSessionId: session.id, paymentIntentId },
  });
  if (!placed.ok && placed.code !== "provider_error") await refund();
  return placed;
}

export type PreApplySubmitGate =
  | { ok: true; row: DemoApplicantRow }
  | { ok: false; status: number; body: Record<string, unknown> };

function rowPropertyId(row: DemoApplicantRow): string {
  return row.assignedPropertyId?.trim() || row.propertyId?.trim() || row.application?.propertyId?.trim() || "";
}

function blockedBody(state: PreApplyState): Record<string, unknown> {
  const step = state.steps.find((entry) => entry.id === state.next);
  const label = step ? PRE_APPLY_STEP_LABELS[step.id] : "the required steps";
  const error =
    step?.reason === "unavailable"
      ? "ID check unavailable."
      : step?.reason === "review"
        ? "Your ID could not be verified. Contact the property manager."
        : `Complete ${label} before you apply.`;
  return {
    error,
    blocked: "preapply",
    step: state.next,
    steps: state.steps,
    ...(step?.id === "verify_id" ? { href: PRE_APPLY_HREF_VERIFY_ID } : {}),
  };
}

/**
 * The server's enforcement of the manager's pre-apply requirements at the moment an application is SUBMITTED
 * (not hidden in the UI): refuses unless every required step is satisfied, and stamps the applicant's Checkr order
 * onto the application so the manager sees it. A listing that requires nothing passes untouched; a requirement that
 * cannot be read refuses.
 */
export async function preApplySubmitGate(
  db: SupabaseClient,
  user: { id: string; email?: string | null },
  row: DemoApplicantRow,
): Promise<PreApplySubmitGate> {
  const propertyId = rowPropertyId(row);
  if (!propertyId) return { ok: true, row };
  // The caller already authorized the write itself (a resident, or a non-resident login applying elsewhere).
  const ctx = await loadPreApplyContext(db, user, propertyId, { requireResident: false });
  if (!ctx.ok) {
    // A listing that cannot be found has no requirement to enforce; the other validators refuse it.
    if (ctx.status === 404) return { ok: true, row };
    return { ok: false, status: ctx.status === 403 ? 403 : 503, body: { error: ctx.error, blocked: "preapply_unavailable" } };
  }
  const resolved = await resolvePreApplyView(db, ctx);
  if (!resolved.ok) return { ok: false, status: resolved.status, body: { error: resolved.error, blocked: "preapply_unavailable" } };
  const { state, record } = resolved.view;
  if (!state.required) return { ok: true, row };
  if (!state.satisfied) return { ok: false, status: 403, body: blockedBody(state) };
  if (!record || row.backgroundCheck) return { ok: true, row };

  // Stamp the check on the application and point the order trail at it (best effort; the row stays correct either way).
  const check = record.check;
  try {
    await db.from("applicant_preapply_checks").update({ application_id: row.id, updated_at: new Date().toISOString() }).eq("id", record.id);
    await upsertPreApplyOrder(db, { applicationId: row.id, managerUserId: ctx.managerUserId, check });
  } catch {
    console.error("pre-apply screening: could not link the check to the application", { applicationId: row.id });
  }
  return {
    ok: true,
    row: { ...row, backgroundCheck: check, backgroundCheckStatus: backgroundCheckStatusFromCheckr(check) },
  };
}

/**
 * A signed-out submit for a listing that requires something before applying. A guest has no account to hold a check
 * or an ID verification, so the server asks them to sign in; a listing that requires nothing is unaffected.
 */
export async function preApplyGuestGate(
  db: SupabaseClient,
  row: DemoApplicantRow,
): Promise<{ ok: true } | { ok: false; status: number; body: Record<string, unknown> }> {
  const propertyId = rowPropertyId(row);
  if (!propertyId) return { ok: true };
  const loaded = await loadPreApplyPlan(db, propertyId);
  if (!loaded.ok) {
    if (loaded.status === 404) return { ok: true };
    return { ok: false, status: 503, body: { error: loaded.error, blocked: "preapply_unavailable" } };
  }
  if (!loaded.plan.verifyId.required && !loaded.plan.backgroundCheck.required) return { ok: true };
  return {
    ok: false,
    status: 403,
    body: {
      error: "Sign in to your resident account and complete the required steps before you apply.",
      blocked: "preapply",
      step: loaded.plan.verifyId.required ? "verify_id" : "background_check",
    },
  };
}
