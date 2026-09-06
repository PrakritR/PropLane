/**
 * AI-style generated residential room rental agreement (HTML).
 * Sections mirror a typical "room lease" / coliving PDF (e.g. *Lease Agreement — Room 1* style):
 * parties, premises & description, term, rent & late payment, security deposit & move-in
 * charges, utilities, use & occupancy, shared spaces & amenities, pets, maintenance & alterations,
 * landlord access, assignment/subletting, insurance, conduct, default & remedies, early termination,
 * notices, attorney fees, entire agreement, governing law, disclosures (lead paint etc.),
 * incorporation of application, rent schedule exhibit, and signature blocks.
 */

import type { MockProperty } from "@/data/types";
import { getPropertyById } from "@/lib/rental-application/data";
import { loadRentalWizardDraft } from "@/lib/rental-application/drafts";
import { resolvePlacementLeaseDates } from "@/lib/rental-application/lease-dates";
import { resolveApplicationPersonalFields } from "@/lib/application-personal-fields";
import {
  activeLeaseTemplateDoc,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import {
  submissionWithLeaseTemplateForApplication,
  BUNDLE_LONG_TERM_SEED_KEY,
  BUNDLE_SHORT_TERM_SEED_KEY,
} from "@/lib/property-lease-template-sync";
import { normalizeApplicationLeaseTerm } from "@/lib/resident-manual-lease-terms";
import { leaseCss } from "@/lib/lease-templates/types";
import { resolveSubmissionRoom, submissionRoomRentLabel } from "@/lib/listing-room-resolution";
import type { RentalWizardFormState } from "@/lib/rental-application/types";
import {
  jurisdictionConfig,
  resolveJurisdiction,
  unsupportedJurisdictionMessage,
  type JurisdictionKey,
} from "@/lib/lease-jurisdiction";
import type { JointLeaseMember } from "@/lib/bundle-group/types";
import { buildPlacementLeaseHtml } from "@/lib/property-lease-placement-html";
import type { LeaseBillingSnapshot } from "@/lib/lease-billing-snapshot";
import { formatRoomPriceAmount, resolveStayPricing, type StayKind } from "@/lib/room-pricing";
import { isDemoModeActive } from "@/lib/demo/demo-session";
import { leaseTemplateObjectPath, legacyLeaseTemplateObjectPath } from "@/lib/lease-template-storage";

type LeaseApplicationWithRentSnapshot = Partial<RentalWizardFormState> & {
  __signedRentLabel?: string;
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function dash(s: string | undefined | null): string {
  const t = (s ?? "").trim();
  return t ? escapeHtml(t) : "—";
}

/** First room choice that resolves to a listing, else the application listing. */
export function resolveLeasedRoomProperty(app: Partial<RentalWizardFormState>): MockProperty | undefined {
  for (const id of [app.roomChoice1, app.roomChoice2, app.roomChoice3]) {
    if (id) {
      const p = getPropertyById(id);
      if (p) return p;
    }
  }
  if (app.propertyId) return getPropertyById(app.propertyId);
  return undefined;
}

export function resolveApplicationListing(app: Partial<RentalWizardFormState>): MockProperty | undefined {
  if (!app.propertyId) return undefined;
  return getPropertyById(app.propertyId);
}

function submissionFor(prop: MockProperty | undefined): ManagerListingSubmissionV1 | undefined {
  return prop?.listingSubmission?.v === 1 ? prop.listingSubmission : undefined;
}

export type LeaseGenerationContext = {
  application: Partial<RentalWizardFormState>;
  leasedRoom: MockProperty | undefined;
  listingProperty: MockProperty | undefined;
  submission: ManagerListingSubmissionV1 | undefined;
  generatedAtIso: string;
  /** Co-tenants on a joint bundle lease (when leaseKind is joint_bundle). */
  jointLeaseMembers?: JointLeaseMember[];
  leaseKind?: "individual" | "joint_bundle";
  /** Amounts aligned with placement + pending household charges when generating from the manager portal. */
  leaseBilling?: LeaseBillingSnapshot;
  /** Property-level template preview — no resident yet; omit disclosure blocks and bracket placeholders. */
  propertyTemplatePreview?: boolean;
  /** When true with `propertyTemplatePreview`, render listing rent/fees/deposits in the summary (generic template editor). */
  listingFeePreview?: boolean;
  /**
   * Legal name of the landlord party, from the manager's own setting
   * (`manager-landlord-profile.ts`). Absent means the manager has not set one — the template then
   * falls back as it always did, and `leaseLandlordNameBlocker` stops the SEND rather than
   * letting a lease name a building, or `[LANDLORD ENTITY NAME]`, as a contracting party.
   */
  landlordLegalName?: string;
};

export function leaseContextFromApplication(
  application: Partial<RentalWizardFormState>,
): LeaseGenerationContext {
  const dates = resolvePlacementLeaseDates({
    leaseTerm: application.leaseTerm,
    leaseStart: application.leaseStart,
    leaseEnd: application.leaseEnd,
    rentalType: application.rentalType,
  });
  const normalizedApplication: Partial<RentalWizardFormState> = {
    ...application,
    ...resolveApplicationPersonalFields({
      name: application.fullLegalName ?? "",
      email: application.email ?? "",
      application: application as RentalWizardFormState,
    }),
    leaseTerm: normalizeApplicationLeaseTerm(dates.leaseTerm || application.leaseTerm || ""),
    leaseStart: dates.leaseStart,
    leaseEnd: dates.leaseEnd,
  };
  const leasedRoom = resolveLeasedRoomProperty(normalizedApplication);
  const listingProperty = resolveApplicationListing(normalizedApplication) ?? leasedRoom;
  const rawSubmission = submissionFor(listingProperty) ?? submissionFor(leasedRoom);
  const submission = rawSubmission
    ? submissionWithLeaseTemplateForApplication(
        normalizeManagerListingSubmissionV1(rawSubmission),
        normalizedApplication,
      )
    : undefined;
  return {
    application: normalizedApplication,
    leasedRoom,
    listingProperty,
    submission,
    generatedAtIso: new Date().toISOString(),
  };
}

/** Rent line for lease tables — from application + listing when available. */
export function rentSummaryFromApplication(application: Partial<RentalWizardFormState> | undefined | null): string | null {
  if (!application || !Object.keys(application).length) return null;
  try {
    const signedRentLabel = (application as LeaseApplicationWithRentSnapshot).__signedRentLabel?.trim();
    if (signedRentLabel) return signedRentLabel;
    const ctx = leaseContextFromApplication(application as RentalWizardFormState);
    const room = ctx.leasedRoom;
    const list = ctx.listingProperty;
    const monthlyRent =
      submissionRoomRentLabel(
        resolveSubmissionRoom(ctx.submission, {
          roomChoices: [application.roomChoice1],
          unitLabel: room?.unitLabel,
        }),
      ) ??
      room?.rentLabel ??
      list?.rentLabel ??
      null;
    if (!monthlyRent) return null;
    const s = typeof monthlyRent === "string" ? monthlyRent : String(monthlyRent);
    if (s.includes("As set forth")) return null;
    return s;
  } catch {
    return null;
  }
}

export function gatherLeaseGenerationContext(): LeaseGenerationContext {
  const application = loadRentalWizardDraft() ?? {};
  return leaseContextFromApplication(application);
}

type LeaseTemplateDocument = { url: string; name: string };

function templateDocumentForFields(fields: {
  leaseConfigMode?: unknown;
  leaseCustomKind?: unknown;
  leaseTemplateDocUrl?: unknown;
  leaseTemplateDocName?: unknown;
}): LeaseTemplateDocument | null {
  const doc = activeLeaseTemplateDoc(fields);
  if (!doc) return null;
  // Persisted templates must resolve to a private object, or to a legacy public
  // listing-media object. Demo is memory-only and deliberately never persists
  // its temporary data URL to a manager property record.
  if (leaseTemplateObjectPath(doc.url) || legacyLeaseTemplateObjectPath(doc.url)) return doc;
  if (isDemoModeActive() && doc.url.startsWith("data:application/pdf;base64,")) return doc;
  return null;
}

/**
 * Select an uploaded PDF only for the stay kind it was configured for.
 *
 * A legacy listing stores one top-level template and has no template array. That
 * document is long-term only. The short-stay branch intentionally returns null
 * so the short-stay agreement is generated instead of serving a residential
 * lease to a guest.
 */
export function selectLeaseTemplateDoc(
  ctx: LeaseGenerationContext,
  stayKind: StayKind,
): LeaseTemplateDocument | null {
  const sub = ctx.submission;
  if (!sub) return null;
  const templates = Array.isArray(sub.propertyLeaseTemplates) ? sub.propertyLeaseTemplates : [];
  const bundlePlacement =
    Boolean(ctx.application.bundleId?.trim()) || ctx.leaseKind === "joint_bundle";

  if (stayKind === "short") {
    const seedKey = bundlePlacement ? BUNDLE_SHORT_TERM_SEED_KEY : "short-term";
    const shortTerm =
      templates.find((template) => template?.listingSeedKey === seedKey) ??
      templates.find((template) => template?.kind === "short-term");
    return shortTerm ? templateDocumentForFields(shortTerm) : null;
  }

  const longSeedKey = bundlePlacement ? BUNDLE_LONG_TERM_SEED_KEY : "primary";
  const longTerm =
    templates.find((template) => template?.listingSeedKey === longSeedKey) ??
    templates.find((template) => template?.kind === "long-term");
  // Existing listings predate propertyLeaseTemplates. Their one top-level
  // document remains the long-term template with no manager action required.
  if (longTerm) return templateDocumentForFields(longTerm);
  // A populated array is an explicit per-stay configuration. It is not a
  // legacy single-field listing, so a short-only row must not serve long stays.
  return templates.length === 0 ? templateDocumentForFields(sub) : null;
}

/** Uploaded template for the placement's resolved stay kind, or null. */
export function leaseTemplateDocForContext(ctx: LeaseGenerationContext): LeaseTemplateDocument | null {
  const room = resolveSubmissionRoom(ctx.submission, {
    roomChoices: [ctx.application.roomChoice1],
    unitLabel: ctx.leasedRoom?.unitLabel,
  });
  const pricing = resolveStayPricing({ room, submission: ctx.submission, application: ctx.application });
  return selectLeaseTemplateDoc(ctx, pricing.stayKind);
}

/** Stable provenance for a manager-uploaded PDF. The rider is version 1.0.0. */
export function leaseTemplateVersionForContext(ctx: LeaseGenerationContext): string | null {
  const room = resolveSubmissionRoom(ctx.submission, {
    roomChoices: [ctx.application.roomChoice1],
    unitLabel: ctx.leasedRoom?.unitLabel,
  });
  const pricing = resolveStayPricing({ room, submission: ctx.submission, application: ctx.application });
  const doc = selectLeaseTemplateDoc(ctx, pricing.stayKind);
  if (!doc) return null;
  const template = (ctx.submission?.propertyLeaseTemplates ?? []).find(
    (candidate) => templateDocumentForFields(candidate)?.url === doc.url,
  );
  return `${template?.id?.trim() || "legacy-manager-uploaded"}@1.0.0`;
}

function money(amount: number | undefined): string {
  return amount === undefined ? "Not set" : formatRoomPriceAmount(amount);
}

function leaseTermsRiderHtml(ctx: LeaseGenerationContext): string {
  const a = ctx.application;
  const sub = ctx.submission ? normalizeManagerListingSubmissionV1(ctx.submission) : undefined;
  const prop = ctx.leasedRoom ?? ctx.listingProperty;
  const room = resolveSubmissionRoom(sub, {
    roomChoices: [a.roomChoice1],
    unitLabel: prop?.unitLabel,
  });
  const pricing = resolveStayPricing({ room, submission: sub, application: a });
  const address = dash(prop?.address ?? sub?.address);
  const cityZipParts = [prop?.neighborhood ?? sub?.neighborhood, prop?.zip ?? sub?.zip].filter(Boolean);
  const cityZip = dash(cityZipParts.join(", "));
  const rate =
    pricing.basis === "daily"
      ? pricing.dailyRate
      : pricing.basis === "weekly"
        ? pricing.weeklyRate
        : pricing.monthlyRate;
  const rateLabel =
    pricing.basis === "daily" ? "Daily rate" : pricing.basis === "weekly" ? "Weekly rent" : "Monthly rent";
  const fees = [
    ctx.leaseBilling?.moveInFee ? ["Move-in fee", money(ctx.leaseBilling.moveInFee)] : null,
    ctx.leaseBilling?.applicationFee ? ["Application fee", money(ctx.leaseBilling.applicationFee)] : null,
    ctx.leaseBilling?.otherCostAmount
      ? [ctx.leaseBilling.otherCostLabel?.trim() || "Other fee", money(ctx.leaseBilling.otherCostAmount)]
      : null,
  ].filter((fee): fee is [string, string] => Boolean(fee));

  return `<section class="terms-rider">
<h1>TERMS RIDER</h1>
<p>This Terms Rider is attached to the manager's lease document. If this Terms Rider conflicts with the base document, this Terms Rider controls for that conflict.</p>
<table>
  <tr><th width="35%">Resident / Tenant</th><td><strong>${dash(a.fullLegalName || "Resident")}</strong><br/>Phone: ${dash(a.phone)} &nbsp;·&nbsp; Email: ${dash(a.email)}</td></tr>
  <tr><th>Property</th><td>${address}${cityZipParts.length > 0 ? `<br/>${cityZip}` : ""}</td></tr>
  <tr><th>Room / unit</th><td>${dash(prop?.unitLabel ?? room?.name)}</td></tr>
  <tr><th>Stay dates</th><td>${dash(a.leaseStart)} to ${dash(a.leaseEnd)}</td></tr>
  <tr><th>Rent basis</th><td>${pricing.basis === "daily" ? "Daily" : pricing.basis === "weekly" ? "Weekly" : "Monthly"}</td></tr>
  <tr><th>${rateLabel}</th><td>${money(rate)}</td></tr>
  <tr><th>Security deposit</th><td>${money(pricing.deposit)}</td></tr>
  ${fees.map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`).join("\n  ")}
</table>
</section>`;
}

/**
 * Lease document for properties whose manager uploaded their own lease template:
 * an attached Terms Rider followed by the manager's unmodified PDF.
 */
function buildManagerTemplateLeaseHtml(ctx: LeaseGenerationContext, doc: { url: string; name: string }): string {
  const tenantName = dash(ctx.application.fullLegalName || "Resident");
  const generatedDate = escapeHtml(
    new Date(ctx.generatedAtIso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }),
  );
  const isPdf = /\.pdf(\?|$)/i.test(doc.url) || doc.url.startsWith("data:application/pdf") || /\.pdf$/i.test(doc.name);
  const docUrl = escapeHtml(doc.url);
  const docName = escapeHtml(doc.name);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Lease Agreement — ${tenantName}</title><style>${leaseCss()}
.doc-embed{width:100%;height:75vh;min-height:640px;border:1px solid #cbd5e1;border-radius:6px;background:#f8fafc}
.doc-link{display:inline-block;margin:6px 0 14px;font-weight:600}</style></head><body>
<h1>LEASE AGREEMENT</h1>
<p class="sub">Prepared from the property manager's lease template · Generated ${generatedDate} via PropLane</p>

${leaseTermsRiderHtml(ctx)}

<h2>Base Lease Document (Manager Template)</h2>
<p>The property manager provided the following lease document for this property. If it does not display below, open it directly:</p>
<a class="doc-link" href="${docUrl}" target="_blank" rel="noopener">Open lease document: ${docName}</a>
${isPdf ? `<object class="doc-embed" data="${docUrl}" type="application/pdf"><p>The document preview could not be shown here. <a href="${docUrl}" target="_blank" rel="noopener">Open ${docName}</a>.</p></object>` : `<iframe class="doc-embed" src="${docUrl}" title="Lease document"></iframe>`}

<h2>Electronic Signature</h2>
<p><strong>Landlord / Authorized Agent</strong> and <strong>Resident / Tenant</strong> each execute this Agreement <strong>one time</strong> through the PropLane portal. The <strong>Electronic Signature Certificate</strong> appended to the signed copy is the binding record for both parties and applies to the manager's lease document above.</p>
</body></html>`;
}

export type LeaseGenerationOutcome =
  | {
      kind: "generated";
      html: string;
      executedJurisdiction: string | null;
      templateVersion: string | null;
      templateDocument: LeaseTemplateDocument | null;
    }
  | {
      kind: "unsupported_jurisdiction";
      error: string;
    };

function executedJurisdictionFor(key: JurisdictionKey | null): string | null {
  if (!key) return null;
  return `US-${key.state}${key.city ? `/${key.city}` : ""}`;
}

/**
 * Build the placement's lease and return a state callers can render without
 * relying on exceptions. A manager template remains available outside the
 * built-in jurisdictions, while a short stay selects only a short-stay template.
 */
export function buildAiGeneratedLeaseHtml(ctx: LeaseGenerationContext): LeaseGenerationOutcome {
  const room = resolveSubmissionRoom(ctx.submission, {
    roomChoices: [ctx.application.roomChoice1],
    unitLabel: ctx.leasedRoom?.unitLabel,
  });
  const pricing = resolveStayPricing({ room, submission: ctx.submission, application: ctx.application });
  const templateDoc = selectLeaseTemplateDoc(ctx, pricing.stayKind);
  const jurisdiction = resolveJurisdiction(ctx);
  const executedJurisdiction = executedJurisdictionFor(jurisdiction);

  if (templateDoc) {
    return {
      kind: "generated",
      html: buildManagerTemplateLeaseHtml(ctx, templateDoc),
      executedJurisdiction,
      templateVersion: leaseTemplateVersionForContext(ctx),
      templateDocument: templateDoc,
    };
  }

  const config = jurisdiction ? jurisdictionConfig(jurisdiction) : null;
  if (!config) {
    return { kind: "unsupported_jurisdiction", error: unsupportedJurisdictionMessage() };
  }

  return {
    kind: "generated",
    html: buildPlacementLeaseHtml(ctx, config),
    executedJurisdiction,
    templateVersion: null,
    templateDocument: null,
  };
}

export function downloadAiGeneratedLeaseHtml(ctx: LeaseGenerationContext): LeaseGenerationOutcome {
  const outcome = buildAiGeneratedLeaseHtml(ctx);
  if (outcome.kind !== "generated" || typeof window === "undefined") return outcome;
  const rawName = (ctx.application.fullLegalName ?? "resident").trim() || "resident";
  const safe = rawName.replace(/[^\w\-]+/g, "_").slice(0, 60) || "resident";
  const blob = new Blob([outcome.html], { type: "text/html;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `PropLane-AI-Lease-${safe}.html`;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return outcome;
}
