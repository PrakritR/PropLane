import type { MockProperty } from "@/data/types";
import { buildAiGeneratedLeaseHtml, type LeaseGenerationContext } from "@/lib/generated-lease";
import { isLeaseGenerationSupported, jurisdictionLabel, resolveLeaseJurisdiction } from "@/lib/lease-jurisdiction";
import {
  activeCustomLeaseTerms,
  activeLeaseTemplateDoc,
  createDefaultListingSubmission,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { stripDisclosureReviewFromLeaseHtml } from "@/lib/property-lease-document-display";
import type { PropertyLeaseTemplateKind } from "@/lib/property-lease-templates";
import { SHORT_TERM_LEASE_TERM } from "@/lib/rental-application/lease-terms";
import { resolvePropertyLeaseSource, type PropertyLeaseSource } from "@/lib/property-lease-source";

/** Generic label for property-level default lease drafts (no listing or resident data). */
export const PROPERTY_LEASE_TEMPLATE_PLACEHOLDER = "Filled at placement";

export type PropertyLeasePreviewHint = {
  buildingName?: string;
  unitLabel?: string;
  rentLabel?: string;
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Avoid "Seattle, WA, Seattle, WA 98101" when the street line already includes city/state. */
/** Avoid duplicating city/state when the street line already includes them. */
export function formatLeaseAddressForDisplay(
  sub: Pick<ManagerListingSubmissionV1, "address" | "neighborhood" | "zip" | "city" | "state">,
): { street: string; cityStateZip: string; full: string } {
  const raw = sub.address.trim();
  const zip = sub.zip.trim();
  const neighborhood = sub.neighborhood.trim();
  const city = sub.city?.trim() ?? "";
  const state = sub.state?.trim().toUpperCase() ?? "";
  const structuredCityState = city && state ? `${city}, ${state}` : city;
  const defaultCityState = structuredCityState || "Seattle, WA";
  const defaultCityStateZip = zip ? `${defaultCityState} ${zip}` : defaultCityState;
  const hasCityState = structuredCityState
    ? new RegExp(structuredCityState.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(raw)
    : /\b(seattle|washington|,\s*wa\b)/i.test(raw);

  let street = raw;
  if (hasCityState) {
    if (structuredCityState) {
      street =
        raw
          .replace(
            new RegExp(`,?\\s*${structuredCityState.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.?\\s*\\d{0,5}`, "i"),
            "",
          )
          .replace(/\s*,\s*$/, "")
          .trim() || raw;
    } else {
      street =
        raw
          .replace(/,?\s*seattle,?\s*wa\.?\s*\d{0,5}/i, "")
          .replace(/,?\s*washington/i, "")
          .replace(/\s*,\s*$/, "")
          .trim() || raw;
    }
  }

  let cityStateZip = defaultCityStateZip;
  if (hasCityState) {
    if (structuredCityState) {
      const inline = raw.match(
        new RegExp(`${structuredCityState.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\.?\\s*\\d{5}`, "i"),
      )?.[0];
      cityStateZip = inline ?? (zip && !raw.includes(zip) ? `${structuredCityState} ${zip}` : defaultCityStateZip);
    } else {
      const inline = raw.match(/seattle,?\s*wa\.?\s*\d{5}/i)?.[0];
      cityStateZip = inline ?? (zip && !raw.includes(zip) ? `Seattle, WA ${zip}` : defaultCityStateZip);
    }
  } else if (neighborhood) {
    cityStateZip = zip ? `${neighborhood}, Seattle, WA ${zip}` : `${neighborhood}, Seattle, WA`;
  }

  const full = hasCityState && /\d{5}/.test(raw) ? raw : `${street}, ${cityStateZip}`;
  return { street: street || raw || "—", cityStateZip, full };
}

function formatCustomLeaseClausesHtml(terms: string): string {
  const trimmed = terms.trim();
  if (!trimmed) return "";
  const paragraphs = trimmed
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (paragraphs.length > 1) {
    return paragraphs.map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`).join("\n");
  }
  const lines = trimmed
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  if (lines.length > 1) {
    return `<ol>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ol>`;
  }
  return `<p>${escapeHtml(trimmed).replace(/\n/g, "<br/>")}</p>`;
}

/** Keep only location signals needed for jurisdiction; omit listing-specific lease fields. */
function jurisdictionStubFromSubmission(sub: ManagerListingSubmissionV1): ManagerListingSubmissionV1 {
  const source = normalizeManagerListingSubmissionV1(sub);
  return normalizeManagerListingSubmissionV1({
    ...createDefaultListingSubmission(),
    zip: source.zip,
  });
}

/** Synthetic placement context for property-level lease previews (no resident yet). */
export function leasePreviewContextFromSubmission(
  sub: ManagerListingSubmissionV1,
  _hint?: PropertyLeasePreviewHint,
  templateKind: PropertyLeaseTemplateKind = "long-term",
  opts?: { templatePreview?: boolean; listingFeePreview?: boolean },
): LeaseGenerationContext {
  const isShortTerm = templateKind === "short-term";
  const propertyTemplatePreview = opts?.templatePreview ?? true;
  const listingFeePreview = Boolean(opts?.listingFeePreview);
  const previewSubmission =
    propertyTemplatePreview && !listingFeePreview
      ? jurisdictionStubFromSubmission(sub)
      : normalizeManagerListingSubmissionV1(sub);
  const leaseTerm = isShortTerm ? SHORT_TERM_LEASE_TERM : "12-Month";
  // A ternary rather than `&&`: the `&&` form yields `false` when not previewing
  // listing fees, and `false.name` is a type error at the use site below.
  // `undefined` is the same falsy value every reader already handles.
  const previewRoom = listingFeePreview
    ? (previewSubmission.rooms.find((r) => r.name.trim()) ?? previewSubmission.rooms[0])
    : undefined;
  const previewAddress = listingFeePreview ? formatLeaseAddressForDisplay(previewSubmission) : null;

  const listingProperty: MockProperty = {
    id: "property-lease-template-draft",
    title: previewSubmission.buildingName?.trim() || "",
    tagline: "",
    address: previewAddress?.street ?? "",
    zip: previewSubmission.zip,
    neighborhood: previewSubmission.neighborhood,
    beds: 0,
    baths: 0,
    rentLabel: "—",
    available: "—",
    petFriendly: false,
    buildingId: "property-lease-template-draft",
    buildingName: previewSubmission.buildingName?.trim() || "",
    unitLabel: previewRoom?.name?.trim() || "",
    listingSubmission: previewSubmission,
    adminPublishLive: true,
  };

  return {
    application: {
      fullLegalName: "",
      email: "",
      phone: "",
      rentalType: isShortTerm ? "short_term" : undefined,
      leaseTerm,
      leaseStart: PROPERTY_LEASE_TEMPLATE_PLACEHOLDER,
      leaseEnd: PROPERTY_LEASE_TEMPLATE_PLACEHOLDER,
      shortTermCheckInTime: "",
      shortTermCheckOutTime: "",
      roomChoice1: previewRoom ? `property-lease-template-draft::${previewRoom.id}` : undefined,
    },
    leasedRoom: listingProperty,
    listingProperty,
    submission: previewSubmission,
    generatedAtIso: new Date().toISOString(),
    propertyTemplatePreview,
    listingFeePreview: listingFeePreview || undefined,
  };
}

function customCommentsPreviewHtml(terms: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><title>Custom lease addendum</title>
<style>
  body { font-family: Georgia, "Times New Roman", serif; color: #1f2430; margin: 32px auto; max-width: 720px; line-height: 1.55; padding: 0 20px; }
  h1 { font-size: 20px; margin-bottom: 4px; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.08em; border-bottom: 1px solid #d8dce4; padding-bottom: 4px; margin-top: 24px; }
  .note { color: #5a6172; font-size: 13px; margin-bottom: 20px; }
  ol { margin: 0.5rem 0 0.5rem 1.25rem; padding: 0; }
  li { margin: 0.35rem 0; font-size: 14px; }
  p { font-size: 14px; }
</style></head><body>
  <h1>Additional Provisions from Property Manager</h1>
  <p class="note">These clauses are merged into the PropLane standard lease when a resident is placed at this property.</p>
  <h2>Custom provisions</h2>
  ${formatCustomLeaseClausesHtml(terms)}
  <h2>Electronic signature</h2>
  <p>Landlord and Resident each execute the combined lease document through the PropLane portal. The Electronic Signature Certificate is the binding record for both parties.</p>
</body></html>`;
}

function customFormatNoticeHtml(docName: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"/><title>Custom lease format</title>
<style>
  body { font-family: system-ui, sans-serif; color: #1f2430; margin: 32px auto; max-width: 720px; line-height: 1.55; padding: 0 20px; }
  h1 { font-size: 18px; }
  h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 0.06em; border-bottom: 1px solid #d8dce4; padding-bottom: 4px; margin-top: 24px; }
  p { font-size: 14px; }
  .doc { font-weight: 600; }
</style></head><body>
  <h1>Custom lease format</h1>
  <p>Lease template: <span class="doc">${escapeHtml(docName)}</span></p>
  <h2>At placement</h2>
  <p>PropLane compiles a placement summary (parties, room, rent, dates) and attaches your PDF as the lease document. Both parties sign once through the PropLane portal.</p>
  <h2>Electronic signature</h2>
  <p>The Electronic Signature Certificate appended to the signed copy is the binding record for both parties.</p>
</body></html>`;
}

function tryBuildFullLeasePreview(
  ctx: LeaseGenerationContext,
): { html: string; plainText: string; jurisdictionLabel: string } | null {
  const jurisdiction = resolveLeaseJurisdiction(ctx);
  const jLabel = jurisdictionLabel(jurisdiction);
  const outcome = buildAiGeneratedLeaseHtml(ctx);
  if (outcome.kind !== "generated") return null;
  return { html: outcome.html, plainText: stripLeaseHtmlToPlainText(outcome.html), jurisdictionLabel: jLabel };
}

export type PropertyLeasePreviewResult = {
  source: PropertyLeaseSource;
  html: string | null;
  plainText: string;
  unsupportedJurisdiction: boolean;
  jurisdictionLabel: string | null;
};

export function buildPropertyLeasePreview(
  sub: ManagerListingSubmissionV1,
  opts?: { hint?: PropertyLeasePreviewHint; demo?: boolean; templateKind?: PropertyLeaseTemplateKind },
): PropertyLeasePreviewResult {
  void opts?.demo;
  const normalized = normalizeManagerListingSubmissionV1(sub);
  const source = resolvePropertyLeaseSource(normalized);
  const templateKind = opts?.templateKind ?? "long-term";

  if (source === "custom_format") {
    const doc = activeLeaseTemplateDoc(normalized);
    if (!doc) {
      return {
        source,
        html: null,
        plainText: "Custom lease format configured — open Edit to upload your PDF template.",
        unsupportedJurisdiction: false,
        jurisdictionLabel: null,
      };
    }
    const plainText = `Lease template: ${doc.name}. PropLane adds a placement summary and e-signatures at signing time.`;
    return {
      source,
      html: customFormatNoticeHtml(doc.name),
      plainText,
      unsupportedJurisdiction: false,
      jurisdictionLabel: null,
    };
  }

  const ctx = leasePreviewContextFromSubmission(normalized, opts?.hint, templateKind, {
    templatePreview: source === "axis_default",
    listingFeePreview: source === "axis_default",
  });
  const jurisdiction = resolveLeaseJurisdiction(ctx);
  const jLabel = jurisdictionLabel(jurisdiction);
  const supported = isLeaseGenerationSupported(jurisdiction);

  const built = tryBuildFullLeasePreview(ctx);
  if (built) {
    return {
      source,
      html: stripDisclosureReviewFromLeaseHtml(built.html),
      plainText: built.plainText,
      unsupportedJurisdiction: false,
      jurisdictionLabel: built.jurisdictionLabel,
    };
  }

  if (source === "custom_comments") {
    const terms = activeCustomLeaseTerms(normalized);
    const plainText = terms
      ? `Additional Provisions from Property Manager\n\n${terms}\n\nThese provisions are merged into the PropLane standard lease when a resident is placed.`
      : "Custom comments configured — open Edit to add lease clauses.";
    return {
      source,
      html: terms ? customCommentsPreviewHtml(terms) : null,
      plainText,
      unsupportedJurisdiction: !supported,
      jurisdictionLabel: supported ? jLabel : null,
    };
  }

  if (!supported) {
    const plainText =
      "PropLane default lease applies at placement. Full preview is available for California and Washington properties, or upload a custom PDF for other locations.";
    return {
      source,
      html: null,
      plainText,
      unsupportedJurisdiction: true,
      jurisdictionLabel: jLabel,
    };
  }

  return {
    source,
    html: null,
    plainText: "PropLane default lease — preview unavailable for this property.",
    unsupportedJurisdiction: true,
    jurisdictionLabel: jLabel,
  };
}

export function stripLeaseHtmlToPlainText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

export function truncateLeasePreviewText(text: string, maxLen = 480): string {
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen).trim()}…`;
}

/** Listing fields that feed each preview section (for tests / docs). */
export function leasePreviewDataFieldMap(): Record<string, string[]> {
  return {
    "Parties & Premises": ["buildingName", "address", "zip", "neighborhood", "rooms[].name"],
    "Term & Rent": ["allowedLeaseTerms", "leaseTermsBody", "rooms[].monthlyRent", "entireHomeMonthlyRent"],
    "Security deposit": ["securityDeposit", "moveInFee", "applicationFee", "paymentAtSigningIncludes"],
    "Utilities & services": ["rooms[].utilitiesEstimate", "entireHomeUtilitiesEstimate", "serviceRequestOptions"],
    "House rules": ["houseRulesText"],
    "Shared spaces & amenities": ["sharedSpaces", "amenitiesText", "houseOverview"],
    "Pets & parking": ["petFriendly", "parkingMonthly", "serviceRequestOptions (pet registration)"],
    "Custom addendum": ["customLeaseTerms (when leaseConfigMode=custom)"],
  };
}
