import { formatLeaseDateLabel, parseFlexibleLocalDate } from "@/lib/rental-application/lease-dates";
import {
  activeCustomLeaseTerms,
  entireHomeMonthlyRentAmount,
  isEntireHomeListing,
  listingSubmissionCityZipLine,
  listingSubmissionStreetLine,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import {
  computeLeasePaymentAtSigning,
  formatListingFeeDisplay,
  paymentAtSigningIncludedLabels,
  utilitiesListingEstimateLabel,
} from "@/lib/rental-application/listing-fees-display";
import { formatUtilitiesListingLine, resolveListingUtilitiesPaymentModel } from "@/lib/listing-utilities-payment";
import {
  hasResidentPaidLeaseUtility,
  leaseUtilityAllowanceNote,
  leaseUtilityKindLabel,
  leaseUtilityPaidByLabel,
  leaseUtilitySetUpByLabel,
  normalizeLeaseUtilities,
  type LeaseUtilityLine,
} from "@/lib/lease-utilities";
import type { RentalWizardFormState } from "@/lib/rental-application/types";
import type { LeaseGenerationContext } from "@/lib/generated-lease";
import { PROPERTY_LEASE_TEMPLATE_PLACEHOLDER } from "@/lib/property-lease-preview";
import { jointLeasePartiesParagraph } from "@/lib/bundle-group/joint-lease";
import { leaseCss, type LeaseJurisdictionTemplateConfig } from "@/lib/lease-templates/types";
import { resolveJurisdiction } from "@/lib/lease-jurisdiction";
import {
  disclosureRulesCatalog,
  disclosureVerbatimHtmlForSection,
  evaluateDisclosureRules,
  type DisclosureRuleEvaluation,
} from "@/lib/lease-templates/disclosure-rules";
import { resolveStayPricing } from "@/lib/room-pricing";
import { resolveSubmissionRoom, submissionRoomRentLabel } from "@/lib/listing-room-resolution";
import {
  intraMonthStaySpan,
  shortTermStayNightCount,
  shortTermStayTotalAmount,
} from "@/lib/short-term-stay-pricing";

type LeaseApplicationWithRentSnapshot = Partial<RentalWizardFormState> & {
  __signedRentLabel?: string;
};

/**
 * The document states the DEPOSIT OBLIGATION, which is fixed at signing, never the resident's
 * running balance, which is not. A holding deposit can be paid before or after the lease is
 * generated, and an executed lease cannot be rebuilt once it carries a signature, so quoting a
 * net figure would permanently over- or understate the deposit depending on that ordering. This
 * sentence is true whether or not a credit exists; the charge ledger and the Payments surface
 * remain the authority for what is actually owed.
 */
const HOLDING_DEPOSIT_CREDIT_NOTE =
  "Any holding deposit already paid for this placement is credited against the security deposit stated above. The charge ledger in the PropLane portal reflects the resulting balance.";

const DISCLOSURE_TEMPLATE_SECTIONS = new Set([
  "Premises",
  "Premises / Municipal compliance",
  "Rent",
  "Rent / Notices",
  "Security Deposit & Move-In Charges",
  "Utilities & Services",
  "House Rules",
  "Default & Remedies / Governing Law",
  "Statutory Disclosures",
  "Lead-Based Paint Disclosure",
  "Addendum A \u2014 Move-In Condition Report",
  "Addendum B \u2014 Bed Bug Disclosure",
  "Addendum C \u2014 Mold & Moisture Policy",
]);

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * A date as a person reads it: "Sep 1, 2026", not "2026-09-01". Residents sign this document,
 * and every date in it was rendering as a raw ISO string. Falls back to the original text when
 * the value is not a parseable date, so a free-text term like "N/A (month-to-month)" survives.
 */
function leaseDate(value: string | undefined | null): string {
  const raw = (value ?? "").trim();
  if (!raw) return "—";
  if (raw === PROPERTY_LEASE_TEMPLATE_PLACEHOLDER) return escapeHtml(PROPERTY_LEASE_TEMPLATE_PLACEHOLDER);
  return escapeHtml(formatLeaseDateLabel(raw) || raw);
}

function dash(s: string | undefined | null): string {
  const t = (s ?? "").trim();
  return t ? escapeHtml(t) : "—";
}

/**
 * Manager-authored lease clauses (Lease step of the create-listing wizard),
 * rendered as an addendum. Plain text: paragraphs split on blank lines.
 */
function customTermsAddendumHtml(
  sub: ManagerListingSubmissionV1 | undefined,
  heading: string,
  skip = false,
): string {
  if (skip) return "";
  const terms = activeCustomLeaseTerms(sub);
  if (!terms) return "";
  const paragraphs = terms
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  let body: string;
  if (paragraphs.length > 1) {
    body = paragraphs.map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br/>")}</p>`).join("\n");
  } else {
    const lines = terms
      .split(/\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    body =
      lines.length > 1
        ? `<ol>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ol>`
        : `<p>${escapeHtml(terms).replace(/\n/g, "<br/>")}</p>`;
  }
  return `
<div class="addendum">
<h2>${escapeHtml(heading)}</h2>
<p><em>The following provisions were supplied by the property manager for this property and form part of this Agreement. If a manager-supplied provision conflicts with applicable law, the law controls.</em></p>
${body}
</div>
`;
}

function unplacedDisclosureRules(evaluation: DisclosureRuleEvaluation): string[] {
  return evaluation.firedRules
    .filter((rule) => rule.template_section && !DISCLOSURE_TEMPLATE_SECTIONS.has(rule.template_section))
    .map((rule) => rule.id);
}

function disclosureReviewNoticeHtml(
  evaluation: DisclosureRuleEvaluation | null,
  canCompleteLease: boolean,
): string {
  if (!evaluation) return "";
  const fieldLabel = (field: string) =>
    disclosureRulesCatalog.trigger_field_dictionary[field]?.description ?? field.replace(/_/g, " ");
  const missing = [...evaluation.unknownTriggers, ...evaluation.unknownUnverifiedTriggers]
    .map(
      ({ rule, field }) =>
        `<li>${escapeHtml(fieldLabel(field))} is required for ${escapeHtml(rule.name)}${rule.cite_verified ? "" : " (citation verification is still pending)"}.</li>`,
    )
    .join("");
  const attachments = evaluation.attachmentRequirements
    .map((rule) => `<li>${escapeHtml(rule.name)}: ${escapeHtml(rule.attachment ?? "")}</li>`)
    .join("");
  const incomplete = missing || attachments;
  const unverified = evaluation.excludedUnverifiedRuleCount
    ? `<p>${evaluation.excludedUnverifiedRuleCount} applicable rule${evaluation.excludedUnverifiedRuleCount === 1 ? " is" : "s are"} excluded because ${evaluation.excludedUnverifiedRuleCount === 1 ? "its citation has" : "their citations have"} not been verified.</p>`
    : "";
  const contentGapCount = evaluation.contentGaps.length + unplacedDisclosureRules(evaluation).length;
  const contentGaps = contentGapCount
    ? `<p>${contentGapCount} verified rule${contentGapCount === 1 ? " has" : "s have"} no safe rendered catalog placement or verbatim body. Legal review must confirm the existing template satisfies ${contentGapCount === 1 ? "it" : "them"}.</p>`
    : "";
  if (!incomplete && !unverified && !contentGaps) return "";
  return `<aside class="disclosure-review" data-disclosure-complete="${canCompleteLease ? "true" : "false"}">
<p><strong>${canCompleteLease ? "Disclosure review" : "Lease completion required"}</strong></p>
${missing ? `<p>This lease cannot be completed until the following information is supplied:</p><ul>${missing}</ul>` : ""}
${attachments ? `<p>These required attachments are not delivered by PropLane and must be provided before completion:</p><ul>${attachments}</ul>` : ""}
${unverified}
${contentGaps}
</aside>`;
}

/**
 * Structured "which utility is included vs. paid separately, who sets it up, and any
 * included allowance" table for the lease's Utilities section. Empty string when the
 * manager configured no breakdown (the lease then falls back to its standard prose).
 */
function utilitiesResponsibilityHtml(lines: readonly LeaseUtilityLine[] | undefined): string {
  if (!lines?.length) return "";
  const rows = lines
    .map((line) => {
      const note = leaseUtilityAllowanceNote(line);
      return `  <tr><td>${escapeHtml(leaseUtilityKindLabel(line))}</td><td>${escapeHtml(
        leaseUtilityPaidByLabel(line),
      )}</td><td>${escapeHtml(leaseUtilitySetUpByLabel(line))}</td><td>${note ? escapeHtml(note) : "—"}</td></tr>`;
    })
    .join("\n");
  return `<p>The following utilities and services apply to the Premises. &quot;Included in rent&quot; means the cost is covered by the monthly rent (up to any allowance shown); otherwise the responsible party sets up the account and pays the provider.</p>
<table>
  <tr><th>Utility / service</th><th>Responsibility</th><th>Account set up by</th><th>Included allowance / notes</th></tr>
${rows}
</table>`;
}

function sharedSpacesLeaseHtml(raw: ManagerListingSubmissionV1 | undefined): string {
  if (!raw?.v) {
    return "<p>Common kitchen, bath, and living areas as shared among residents.</p>";
  }
  const sub = normalizeManagerListingSubmissionV1(raw);
  const entries = sub.sharedSpaces?.filter((s) => s.name.trim()) ?? [];
  if (!entries.length) {
    return "<p>Common kitchen, bath, and living areas as shared among residents.</p>";
  }
  const items = entries.map((s) => {
    const names = (s.roomAccessIds ?? [])
      .map((id) => sub.rooms.find((r) => r.id === id)?.name?.trim())
      .filter(Boolean)
      .join(", ");
    const head = names.length
      ? `${s.name.trim()} — access includes: ${names}`
      : s.name.trim();
    const d = s.detail.trim();
    return escapeHtml(d ? `${head}. ${d}` : `${head}.`);
  });
  return `<ul class="lease-shared-spaces">${items.map((line) => `<li>${line}</li>`).join("")}</ul>`;
}

function leaseAmenitiesSummaryHtml(raw: string | undefined): string {
  const items = (raw ?? "")
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (!items.length) return escapeHtml("See listing amenities.");
  return escapeHtml(items.join(", "));
}

function bathroomArrangementLeaseParagraph(
  raw: ManagerListingSubmissionV1 | undefined,
  roomId: string | undefined,
): string {
  if (!raw?.v || !roomId) return "";
  const sub = normalizeManagerListingSubmissionV1(raw);
  const room = sub.rooms.find((candidate) => candidate.id === roomId);
  if (!room?.name.trim()) return "";
  const bathrooms = sub.bathrooms.filter(
    (bathroom) => bathroom.allResidents || bathroom.assignedRoomIds.includes(roomId),
  );
  if (!bathrooms.length) return "";
  return bathrooms
    .map((bathroom) => {
      const bathroomName = bathroom.name.trim() || "the bathroom";
      if (bathroom.allResidents) return `${bathroomName} is shared by all residents.`;
      const roomNames = bathroom.assignedRoomIds
        .map((id) => sub.rooms.find((candidate) => candidate.id === id)?.name.trim())
        .filter((name): name is string => Boolean(name));
      const peers = roomNames.filter((name) => name !== room.name.trim());
      return peers.length
        ? `${bathroomName} is shared with ${peers.join(", ")}.`
        : `${bathroomName} is assigned to this room.`;
    })
    .join(" ");
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] ?? s[v] ?? s[0])!;
}

function parseAmount(s: string | undefined | null): number | null {
  if (!s) return null;
  const m = s.match(/\$?([\d,]+(?:\.\d+)?)/);
  if (!m) return null;
  return parseFloat(m[1]!.replace(/,/g, ""));
}

function fmtUsd(n: number): string {
  return "$" + n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function isMonthToMonthLease(application: Partial<RentalWizardFormState> | undefined | null): boolean {
  return application?.rentalType !== "short_term" && application?.leaseTerm?.trim() === "Month-to-Month";
}

function overrideFeeLabel(overrideRaw: string | undefined | null, fallbackLabel: string): string {
  const override = String(overrideRaw ?? "").trim();
  if (override) {
    const amount = parseAmount(override);
    return amount != null ? fmtUsd(amount) : override;
  }
  // Format the listing fallback as currency too — the listing-fee normalization stores
  // amounts without a "$" (e.g. "500.00"), and a lease must show "$500.00", not "500.00".
  const fallbackAmount = parseAmount(fallbackLabel);
  return fallbackAmount != null ? fmtUsd(fallbackAmount) : fallbackLabel;
}

function isMonthToMonthOtherCost(label: string | undefined | null): boolean {
  const normalized = String(label ?? "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, " ");
  return normalized.includes("month to month");
}

type ProrateOptions = {
  method?: "auto" | "daily_rate";
  dailyRentRate?: number;
  dailyUtilitiesRate?: number;
  /**
   * Daily-basis mode. Rent already bills each month by its real day count, so prorating it
   * would misread the day rate as a monthly figure — but utilities are still a monthly
   * estimate and the ledger still prorates them, so the section renders utilities only.
   * The amount is passed explicitly (the ledger's billable monthly utilities), never parsed
   * back out of the display label.
   */
  utilitiesOnly?: boolean;
  utilitiesAmount?: number;
  /** When the ledger snapshot is available, use its prorated amounts so the document matches payments. */
  ledgerProratedRent?: number;
  ledgerProratedUtilities?: number;
};

/** Cross-reference placeholders, resolved once every section has claimed its number. */
const RENT_SECTION_TOKEN = "__RENT_SECTION__";
const UTILITIES_SECTION_TOKEN = "__UTILITIES_SECTION__";

/** Placeholder for the prorated section's number, swapped for a counter value at render. */
const PRORATED_SECTION_TOKEN = "__PRORATED_SECTION__";

function proratedBlock(
  monthlyRentStr: string,
  utilitiesStr: string,
  leaseStartStr: string,
  leaseEndStr: string,
  prorate?: ProrateOptions,
): string {
  const utilitiesOnly = prorate?.utilitiesOnly === true;
  const rent = parseAmount(monthlyRentStr);
  if ((!rent && !utilitiesOnly) || !leaseStartStr || leaseStartStr === "—") return "";
  try {
    const start = parseFlexibleLocalDate(leaseStartStr);
    if (!start || isNaN(start.getTime())) return "";
    const utils = utilitiesOnly ? (prorate?.utilitiesAmount ?? 0) : parseAmount(utilitiesStr);
    if (utilitiesOnly && !(utils && utils > 0)) return "";
    // Mirrors the ledger's `leaseFirstPeriodProration`: a daily-basis lease that starts AND
    // ends inside one calendar month is billed as ONE span, so its utilities prorate across
    // the whole term rather than from the lease start to month end.
    const span = utilitiesOnly ? intraMonthStaySpan(leaseStartStr, leaseEndStr) : null;
    const day = start.getDate();
    const hasLedgerProration =
      (prorate?.ledgerProratedRent != null && prorate.ledgerProratedRent > 0) ||
      (prorate?.ledgerProratedUtilities != null && prorate.ledgerProratedUtilities > 0);
    if (!span && day === 1 && !hasLedgerProration) return "";
    const dim = span ? span.daysInMonth : new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
    const remaining = span ? span.billableDays : dim - day + 1;
    const useManual = prorate?.method === "daily_rate" && prorate.dailyRentRate && prorate.dailyRentRate > 0;
    // The ledger gates the daily utilities rate on `prorateMethod === "daily_rate"`, and a
    // positive `dailyUtilitiesRate` survives on the room after the manager switches proration
    // back to "auto" (the wizard only rewrites `prorateMethod`). Dropping that condition here
    // would prorate off a stale rate the ledger ignores, so the same gate applies on both sides.
    const useManualUtils =
      prorate?.method === "daily_rate" && prorate.dailyUtilitiesRate && prorate.dailyUtilitiesRate > 0;
    const proratedRent =
      utilitiesOnly || !rent
        ? 0
        : useManual
          ? Math.round(prorate!.dailyRentRate! * remaining * 100) / 100
          : Math.round((rent / dim) * remaining * 100) / 100;
    const proratedUtils = useManualUtils
      ? Math.round(prorate!.dailyUtilitiesRate! * remaining * 100) / 100
      : utils ? Math.round((utils / dim) * remaining * 100) / 100 : null;
    let finalProratedRent = proratedRent;
    let finalProratedUtils = proratedUtils;
    if (prorate?.ledgerProratedRent != null || prorate?.ledgerProratedUtilities != null) {
      finalProratedRent = utilitiesOnly ? 0 : (prorate.ledgerProratedRent ?? 0);
      finalProratedUtils =
        prorate.ledgerProratedUtilities != null && prorate.ledgerProratedUtilities > 0
          ? prorate.ledgerProratedUtilities
          : utilitiesOnly
            ? (prorate.ledgerProratedUtilities ?? 0)
            : proratedUtils;
    }
    const total = finalProratedRent + (finalProratedUtils ?? 0);
    // The header must describe the figure actually printed in the column: a room with no
    // dailyUtilitiesRate shows its MONTHLY estimate even in utilities-only mode.
    const rateCol = (utilitiesOnly ? useManualUtils : useManual) ? "Daily rate" : "Monthly rate";
    const rentRateDisplay = useManual ? fmtUsd(prorate!.dailyRentRate!) + "/day" : rent ? fmtUsd(rent) : "—";
    const utilRateDisplay = useManualUtils
      ? fmtUsd(prorate!.dailyUtilitiesRate!) + "/day"
      : utils ? fmtUsd(utils) : null;
    const heading = utilitiesOnly ? "Prorated Utilities" : "Prorated First Month";
    const intro = utilitiesOnly
      ? span
        ? `Because the term begins and ends within one calendar month, the utilities estimate is prorated across the term as follows (${remaining} of ${dim} days). Rent is not prorated: it is billed by the day, as stated in Section 4.`
        : `Because the Lease commences on the <strong>${ordinal(day)}</strong> of the month, the first partial month's utilities estimate is prorated as follows (${remaining} of ${dim} days). Rent is not prorated: it is billed by the day, as stated in Section 4.`
      : `Because the Lease commences on the <strong>${ordinal(day)}</strong> of the month, the first partial month is prorated as follows (${remaining} of ${dim} days):`;
    const closing = utilitiesOnly
      ? span
        ? ""
        : `<p>Beginning the first full month, the full monthly utilities estimate stated in Section 4 applies.</p>`
      : `<p>Beginning the first full month, regular rent and utilities as stated in Sections ${RENT_SECTION_TOKEN} and ${UTILITIES_SECTION_TOKEN} apply.</p>`;
    return `
<h2>${PRORATED_SECTION_TOKEN}. ${heading}</h2>
<p>${intro}</p>
<table>
  <tr><th>Item</th><th>${rateCol}</th><th>${utilitiesOnly ? "Days billed" : "Days remaining"}</th><th>Prorated amount</th></tr>
  ${utilitiesOnly ? "" : `<tr><td>Rent</td><td>${rentRateDisplay}</td><td>${remaining} / ${dim}</td><td>${fmtUsd(finalProratedRent)}</td></tr>`}
  ${finalProratedUtils != null && (utilitiesOnly ? finalProratedUtils > 0 : utilRateDisplay != null) ? `<tr><td>Utilities estimate</td><td>${utilRateDisplay ?? (finalProratedUtils > 0 ? fmtUsd(finalProratedUtils) : "—")}</td><td>${remaining} / ${dim}</td><td>${fmtUsd(finalProratedUtils)}</td></tr>` : ""}
  <tr class="total-row"><td colspan="3"><strong>${utilitiesOnly ? "Prorated utilities due" : "Prorated total due first month"}</strong></td><td><strong>${fmtUsd(total)}</strong></td></tr>
</table>
${closing}
`;
  } catch {
    return "";
  }
}

function resolveLongTermFeeAmount(
  raw: string | undefined | null,
  normalized: string | undefined,
  configDefault: number | undefined,
): number | null {
  if (typeof raw === "string" && raw.trim()) {
    const parsed = parseAmount(normalized ?? raw);
    return parsed != null && parsed > 0 ? parsed : null;
  }
  return configDefault != null && configDefault > 0 ? configDefault : null;
}

function resolveLongTermLeaseUpFeePercent(
  raw: number | undefined,
  rawWasProvided: boolean,
  configDefault: number | undefined,
): number | undefined {
  if (rawWasProvided) return raw;
  return configDefault;
}

/** Full HTML document suitable for download and "Print to PDF". */

export function buildLeaseHtml(ctx: LeaseGenerationContext, config: LeaseJurisdictionTemplateConfig): string {
  const { application: a, leasedRoom: room, listingProperty: list, submission: sub, generatedAtIso } = ctx;
  const signedRentLabel = (a as LeaseApplicationWithRentSnapshot).__signedRentLabel?.trim();

  // ── Identity ──────────────────────────────────────────────────────────────
  const propertyTemplatePreview = Boolean(ctx.propertyTemplatePreview);
  const tenantRaw = (a.fullLegalName ?? "").trim() || (propertyTemplatePreview ? "" : "Resident");
  const jointTenants =
    ctx.leaseKind === "joint_bundle" && ctx.jointLeaseMembers?.length
      ? ctx.jointLeaseMembers.map((m) => m.residentName).filter(Boolean)
      : [];
  const tenantName =
    jointTenants.length > 0
      ? escapeHtml(jointTenants.join(", "))
      : propertyTemplatePreview && !tenantRaw
        ? "—"
        : escapeHtml(tenantRaw);
  const jointPartiesNote =
    jointTenants.length > 0 && ctx.jointLeaseMembers
      ? jointLeasePartiesParagraph(ctx.jointLeaseMembers)
      : "";
  const tenantPhone = dash(a.phone);
  const tenantEmail = dash(a.email);
  const tenantDob = dash(a.dateOfBirth);
  const employer = dash(a.employer);
  const jobTitle = dash(a.jobTitle);
  const monthlyIncome = dash(a.monthlyIncome);
  const occupancy = dash(a.occupancyCount);
  const pets = dash(a.pets);

  // ── Landlord ─────────────────────────────────────────────────────────────
  // Only the manager's configured legal name may appear as the contracting party. A building name
  // is a place, not a person — using it as the landlord shipped real leases that named an address
  // as the operator. When the name is unset the template prints the explicit placeholder and
  // `leaseLandlordNameBlocker` refuses the send.
  const buildingLabel = propertyTemplatePreview
    ? ""
    : sub?.buildingName?.trim() || list?.buildingName?.trim() || room?.buildingName?.trim() || "";
  const landlordEntity = escapeHtml(
    propertyTemplatePreview
      ? PROPERTY_LEASE_TEMPLATE_PLACEHOLDER
      : ctx.landlordLegalName?.trim() || "[LANDLORD ENTITY NAME]",
  );
  const landlordPropertyLine =
    !propertyTemplatePreview && buildingLabel && buildingLabel !== ctx.landlordLegalName?.trim()
      ? `<br/>Property: ${escapeHtml(buildingLabel)}`
      : "";
  const subNorm = sub ? normalizeManagerListingSubmissionV1(sub) : undefined;
  const streetFromSubmission = subNorm ? listingSubmissionStreetLine(subNorm).trim() : "";
  const address = propertyTemplatePreview
    ? "—"
    : escapeHtml(
        streetFromSubmission ||
          room?.address?.trim() ||
          list?.address?.trim() ||
          sub?.address?.trim() ||
          "",
      );
  const cityZip = propertyTemplatePreview
    ? "—"
    : subNorm
      ? listingSubmissionCityZipLine(subNorm)
      : [room?.zip ?? list?.zip].filter(Boolean).join(" ");
  const landlordMailing = propertyTemplatePreview ? "—" : address + (cityZip ? `, ${escapeHtml(cityZip)}` : "");

  // ── Room / premises ───────────────────────────────────────────────────────
  // The SAME chain the charge ledger uses, so this document can never be priced off a
  // different room than the one the resident is billed for.
  const specificRoom = resolveSubmissionRoom(subNorm, {
    roomChoices: [a.roomChoice1],
    unitLabel: room?.unitLabel,
    signedMonthlyRent: parseAmount(signedRentLabel ?? "") ?? undefined,
  });

  // Bundle application: the leased premises are the bundle's rooms, not one room.
  const leasedBundle = a.bundleId?.trim()
    ? subNorm?.bundles.find((b) => b.id === a.bundleId!.trim())
    : undefined;
  const bundleRooms = leasedBundle
    ? ((leasedBundle.includedRoomIds?.length ?? 0) > 0
        ? (subNorm?.rooms ?? []).filter((r) => leasedBundle.includedRoomIds?.includes(r.id))
        : (subNorm?.rooms ?? []).filter((r) => r.name.trim()))
    : [];
  const bundleRoomNames = bundleRooms.map((r) => r.name.trim()).filter(Boolean);
  const allListingRoomIds = (subNorm?.rooms ?? []).map((r) => r.id);
  const bundleCoversEntireHome =
    Boolean(leasedBundle && subNorm) &&
    (isEntireHomeListing(subNorm!) ||
      !leasedBundle!.includedRoomIds?.length ||
      leasedBundle!.includedRoomIds!.length >= allListingRoomIds.length);
  const bundlePremisesLabel = leasedBundle
    ? bundleCoversEntireHome
      ? "Entire home"
      : [leasedBundle.label.trim() || "Lease bundle", bundleRoomNames.length ? bundleRoomNames.join(", ") : leasedBundle.roomsLine.trim()]
          .filter(Boolean)
          .join(" — ")
    : "";

  // Whole-home application: the premises are the entire unit. Derived from the LISTING, not
  // from whether a room record resolved — the shared resolver can now match a single unnamed
  // room record on an entire-home listing, which is still a whole-home placement.
  // The unnamed-rooms clause stays gated on `!specificRoom`: a plain SHARED-home listing whose
  // rooms simply have no names would otherwise describe a single-room letting as "Entire home"
  // on an executed lease. An entire-home LISTING is whole-home regardless of what resolved.
  const wholeHome =
    !leasedBundle &&
    Boolean(subNorm) &&
    (isEntireHomeListing(subNorm!) || (!specificRoom && !subNorm!.rooms.some((r) => r.name.trim())));

  const roomLabel = escapeHtml(
    propertyTemplatePreview
      ? PROPERTY_LEASE_TEMPLATE_PLACEHOLDER
      : bundlePremisesLabel ||
          (wholeHome ? "Entire home" : "") ||
          specificRoom?.name?.trim() ||
          room?.unitLabel?.trim() ||
          "[ROOM NUMBER]",
  );
  const fullPremises = escapeHtml(
    propertyTemplatePreview
      ? PROPERTY_LEASE_TEMPLATE_PLACEHOLDER
      : [
          sub?.buildingName ?? list?.buildingName ?? room?.buildingName,
          bundlePremisesLabel || (wholeHome ? "entire home" : "") || specificRoom?.name || room?.unitLabel,
        ]
          .filter(Boolean)
          .join(" — ") || "the Premises described herein",
  );

  // ── Stay pricing ──────────────────────────────────────────────────────────
  // One resolver decides the stay's kind, rate, and deposit, so this document and the
  // charge ledger can never quote different numbers — on EITHER branch. It is resolved
  // before the rent block because the long-form lease has to quote the daily rate too.
  const stay = resolveStayPricing({
    // A bundle application leases the bundle's rooms, not one room, so a stray roomChoice1
    // must not let one member room's daily price decide the whole document's type.
    room: leasedBundle ? undefined : specificRoom,
    submission: subNorm,
    application: {
      rentalType: a.rentalType,
      leaseStart: a.leaseStart,
      leaseEnd: a.leaseEnd,
      managerRentOverride: a.managerRentOverride,
      managerSecurityDepositOverride: a.managerSecurityDepositOverride,
      signedMonthlyRent: parseAmount(signedRentLabel ?? "") ?? undefined,
    },
  });
  const dailyBasisRate = stay.basis === "daily" ? stay.dailyRate : undefined;
  const isDailyBasis = dailyBasisRate !== undefined;

  // ── Rent & financials ─────────────────────────────────────────────────────
  const bundleRentLabel = leasedBundle?.price.trim() || "";
  const entireHomeRent = wholeHome && subNorm ? entireHomeMonthlyRentAmount(subNorm) : 0;
  const monthlyRentBaseStr = propertyTemplatePreview
    ? "—"
    : (isDailyBasis ? `${fmtUsd(dailyBasisRate!)} / day` : "") ||
      overrideFeeLabel(a.managerRentOverride, "") ||
      signedRentLabel ||
      bundleRentLabel ||
      (entireHomeRent > 0 ? `$${entireHomeRent.toFixed(2)} / month` : "") ||
      submissionRoomRentLabel(specificRoom) ||
      room?.rentLabel ||
      list?.rentLabel ||
      "As set forth in the Rent Schedule";
  // A per-day figure never sits under a "Monthly" label.
  const rentRowLabel = isDailyBasis ? "Daily base rent" : "Monthly base rent";
  const monthlyRentStr = monthlyRentBaseStr;

  const rentNum = parseAmount(monthlyRentStr);
  const utilitiesModel = resolveListingUtilitiesPaymentModel(sub ?? undefined, specificRoom ?? undefined);
  const utilitiesBase =
    formatUtilitiesListingLine(utilitiesModel, specificRoom?.utilitiesEstimate?.trim()) ||
    (sub ? utilitiesListingEstimateLabel(sub) : "") ||
    "—";
  const utilitiesStr = propertyTemplatePreview
    ? "—"
    : escapeHtml(overrideFeeLabel(a.managerUtilitiesOverride, utilitiesBase));
  const utilitiesNum =
    utilitiesModel === "manager_billed" && !a.managerUtilitiesOverride?.trim()
      ? parseAmount(specificRoom?.utilitiesEstimate?.trim() || utilitiesBase)
      : a.managerUtilitiesOverride?.trim()
        ? parseAmount(a.managerUtilitiesOverride)
        : utilitiesModel === "manager_billed"
          ? parseAmount(utilitiesBase)
          : 0;
  // Adding a per-day rate to a monthly utilities figure is meaningless arithmetic, and a
  // 30-day estimate is display-only and must never appear in a lease. A daily basis states
  // the billing rule in prose instead of a fabricated monthly total.
  const totalMonthly =
    rentNum != null && !isDailyBasis
      ? fmtUsd(rentNum + (utilitiesNum != null && utilitiesNum > 0 ? utilitiesNum : 0))
      : null;

  const appFee = escapeHtml(propertyTemplatePreview ? "—" : formatListingFeeDisplay(sub?.applicationFee ?? ""));
  // One derivation for the deposit, exactly as for the rate: `resolveStayPricing` already
  // picked the field the ledger will charge (override, then shortTermDeposit or
  // securityDeposit keyed on rentalType). Recomputing it here let the document and the ledger
  // drift the moment either rule changed.
  const secDep = escapeHtml(propertyTemplatePreview ? "—" : stay.deposit !== undefined ? fmtUsd(stay.deposit) : "—");
  // Room-first, then the listing, matching the ledger. A room carrying its own move-in fee
  // is charged that fee, so a lease quoting the listing's figure understates what is owed.
  const moveInFee = escapeHtml(
    propertyTemplatePreview
      ? "—"
      : overrideFeeLabel(
          a.managerMoveInFeeOverride,
          specificRoom?.moveInFee?.trim() || sub?.moveInFee || "—",
        ),
  );
  const rawOtherCostLabel = a.managerOtherCostLabel?.trim() || "Other costs";
  const otherCostIsMonthToMonth = isMonthToMonthOtherCost(rawOtherCostLabel);
  const otherCostLabel = escapeHtml(rawOtherCostLabel);
  const otherCostAmount = escapeHtml(overrideFeeLabel(a.managerOtherCostAmount, "—"));
  const otherCostNum = otherCostIsMonthToMonth ? 0 : parseAmount(a.managerOtherCostAmount);
  const showOtherSigningCost = !otherCostIsMonthToMonth && Boolean(otherCostNum && otherCostNum > 0);

  // One-time custom fees the manager added DO bill (once at move-in, via
  // recordApprovedApplicationCharges), so they must appear in the lease and count toward the
  // total due at signing — a lease that omits a billed charge is a legal problem. Only
  // genuinely-custom rows are listed here (preset-backed rows render through their own lines);
  // monthly custom fees are intentionally NOT listed because they do not yet bill.
  const billableOneTimeCustomFees = propertyTemplatePreview
    ? []
    : (sub?.customFees ?? []).filter((fee) => {
    const presetId = (fee as { presetId?: string }).presetId;
    if (presetId && presetId !== "custom") return false;
    if (fee.frequency !== "one-time") return false;
    const n = parseAmount(fee.amount);
    return n != null && n > 0;
  });
  const customFeesTotalNum = billableOneTimeCustomFees.reduce((s, f) => s + (parseAmount(f.amount) ?? 0), 0);
  const customFeeSigningRows = billableOneTimeCustomFees
    .map((f) => `  <tr><th>${escapeHtml(f.label?.trim() || "Custom fee")}</th><td class="amount">${escapeHtml(fmtUsd(parseAmount(f.amount) ?? 0))}</td></tr>`)
    .join("\n");
  // Monthly custom fees now bill (recurring, alongside rent), so they too must appear in the
  // lease — as Monthly line items in Exhibit A (not in the due-at-signing total).
  const billableMonthlyCustomFees = propertyTemplatePreview
    ? []
    : (sub?.customFees ?? []).filter((fee) => {
    const presetId = (fee as { presetId?: string }).presetId;
    if (presetId && presetId !== "custom") return false;
    if (fee.frequency === "one-time") return false;
    const n = parseAmount(fee.amount);
    return n != null && n > 0;
  });
  const customFeeExhibitRows = [...billableOneTimeCustomFees, ...billableMonthlyCustomFees]
    .map(
      (f) =>
        `  <tr><td>${escapeHtml(f.label?.trim() || "Custom fee")}</td><td class="amount">${escapeHtml(fmtUsd(parseAmount(f.amount) ?? 0))}</td><td>${
          f.frequency === "one-time" ? "One-time" : "Monthly"
        }</td></tr>`,
    )
    .join("\n");

  const leaseBilling = ctx.leaseBilling;
  const signingAmounts = {
    securityDeposit: leaseBilling?.securityDeposit ?? parseAmount(secDep) ?? 0,
    moveInFee: leaseBilling?.moveInFee ?? parseAmount(moveInFee) ?? 0,
    monthlyRent: leaseBilling?.monthlyRent ?? rentNum ?? 0,
    monthlyUtilities: leaseBilling?.monthlyUtilities ?? utilitiesNum ?? 0,
    proratedRent: leaseBilling?.proratedRent,
    proratedUtilities: leaseBilling?.proratedUtilities,
    customOneTimeFees: customFeesTotalNum,
    otherSigningCost: showOtherSigningCost ? (otherCostNum ?? 0) : 0,
  };
  const computedSigning = sub
    ? computeLeasePaymentAtSigning(sub, signingAmounts)
    : signingAmounts.securityDeposit + signingAmounts.moveInFee;
  const paySigningNum =
    leaseBilling?.dueAtSigning != null ? leaseBilling.dueAtSigning : computedSigning;
  const paySigning = escapeHtml(
    propertyTemplatePreview ? "—" : paySigningNum > 0 ? fmtUsd(paySigningNum) : "—",
  );
  const paySigningIncludesNote = sub
    ? escapeHtml(paymentAtSigningIncludedLabels(sub))
    : "";

  // The catalog receives only facts available to lease generation. Fields that the product
  // does not collect stay undefined so the evaluator can report them as unknown rather than
  // silently treating a missing answer as a negative answer.
  const disclosureJurisdiction = stay.stayKind === "long" ? resolveJurisdiction(ctx) : null;
  const disclosureEvaluation = disclosureJurisdiction
    ? evaluateDisclosureRules({
        jurisdiction: disclosureJurisdiction,
        fields: {
          year_built: subNorm?.yearBuilt,
          shared_utility_metering: subNorm?.sharedUtilityMetering,
          has_periodic_pest_service: subNorm?.hasPeriodicPestService,
          certificate_of_occupancy_date: subNorm?.certificateOfOccupancyDate,
          rrio_registration_number: subNorm?.rrioRegistrationNumber,
          city: disclosureJurisdiction.city,
          lease_start_date: a.leaseStart,
          ab1482_exempt: (a as { ab1482Exempt?: unknown }).ab1482Exempt,
          is_rent_ordinance_covered: (a as { isRentOrdinanceCovered?: unknown }).isRentOrdinanceCovered,
          collects_deposit: (stay.deposit ?? 0) > 0,
          has_nonrefundable_fee: (parseAmount(moveInFee) ?? 0) > 0 || billableOneTimeCustomFees.length > 0,
        },
      })
    : null;
  const disclosureCanCompleteLease =
    disclosureEvaluation?.canCompleteLease === true && unplacedDisclosureRules(disclosureEvaluation).length === 0;
  const disclosureReviewNotice = propertyTemplatePreview
    ? ""
    : disclosureReviewNoticeHtml(disclosureEvaluation, disclosureCanCompleteLease);
  const disclosureHtml = (templateSection: string) =>
    disclosureEvaluation ? disclosureVerbatimHtmlForSection(disclosureEvaluation, templateSection) : "";
  const premisesDisclosureHtml = disclosureHtml("Premises / Municipal compliance");
  const premisesBaseDisclosureHtml = disclosureHtml("Premises");
  const rentDisclosureHtml = disclosureHtml("Rent");
  const depositDisclosureHtml = disclosureHtml("Security Deposit & Move-In Charges");
  const utilitiesDisclosureHtml = disclosureHtml("Utilities & Services");
  const houseRulesDisclosureHtml = disclosureHtml("House Rules");
  const defaultDisclosureHtml = disclosureHtml("Default & Remedies / Governing Law");
  const noticesDisclosureHtml = disclosureHtml("Rent / Notices");
  const statutoryDisclosureHtml = disclosureHtml("Statutory Disclosures");
  const leadDisclosureFired = disclosureHtml("Lead-Based Paint Disclosure");
  // A legally required disclosure must NEVER disappear because a trigger field is blank.
  // fed-lead-paint keys on year_built, which is unknown on most listings, so keying the
  // SECTION on firedRules dropped the federal lead-paint disclosure from every lease whose
  // year is unset. That is precisely the fail-toward-silence this engine exists to prevent.
  // When the trigger is unknown, fall back to the self-qualifying paragraph, which is correct
  // whether or not the year is eventually supplied.
  const leadTriggerUnknown = Boolean(
    disclosureEvaluation &&
      [...disclosureEvaluation.unknownTriggers, ...disclosureEvaluation.unknownUnverifiedTriggers].some(
        (entry) => entry.rule.id === "fed-lead-paint",
      ),
  );
  const leadDisclosureHtml =
    leadDisclosureFired ||
    (leadTriggerUnknown || !disclosureEvaluation
      ? `<p data-disclosure-rule="fed-lead-paint">If the property was built before 1978, federal law (42 U.S.C. &sect; 4852d) requires disclosure of known lead-based paint hazards. Resident acknowledges receiving the EPA pamphlet &quot;Protect Your Family From Lead in Your Home&quot; or waiving receipt in writing. Landlord discloses any known lead hazards in the separate disclosure addendum attached hereto (or: no known lead paint hazards).</p>`
      : "");
  const moveInDisclosureHtml = disclosureHtml("Addendum A \u2014 Move-In Condition Report");
  const bedBugDisclosureHtml = disclosureHtml("Addendum B \u2014 Bed Bug Disclosure");
  const moldDisclosureHtml = disclosureHtml("Addendum C \u2014 Mold & Moisture Policy");

  // ── Dates ─────────────────────────────────────────────────────────────────
  const leaseTerm = dash(a.leaseTerm);
  const leaseStart = leaseDate(a.leaseStart);
  const leaseEnd =
    a.leaseTerm === "Month-to-Month" ? leaseDate(a.leaseEnd || "N/A (month-to-month)") : leaseDate(a.leaseEnd);
  const generatedDate = propertyTemplatePreview
    ? "PropLane default template"
    : escapeHtml(new Date(generatedAtIso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }));

  // ── Content blocks ────────────────────────────────────────────────────────
  const leaseTermsBody = escapeHtml(
    propertyTemplatePreview
      ? "Lease term options are filled when a resident is placed at this property."
      : sub?.leaseTermsBody?.trim() || "Standard lease lengths and renewal as posted on the listing.",
  );
  const sharedSpacesHtml = propertyTemplatePreview ? "" : sharedSpacesLeaseHtml(sub);
  const leaseUtilityLines = normalizeLeaseUtilities(subNorm?.leaseUtilities);
  const utilitiesBreakdown = utilitiesResponsibilityHtml(leaseUtilityLines);
  const utilitiesEstimateSentence = !utilitiesBreakdown
    ? "This covers a prorated share of household utilities including electricity, gas, water, sewer, trash, and high-speed internet as applicable to this property."
    : hasResidentPaidLeaseUtility(leaseUtilityLines ?? [])
      ? "This estimate reflects the utilities the Resident is responsible for above."
      : "All utilities and services listed above are included in the monthly rent or paid by Landlord, up to any allowance shown.";
  const amenitiesHtml = propertyTemplatePreview
    ? escapeHtml(PROPERTY_LEASE_TEMPLATE_PLACEHOLDER)
    : leaseAmenitiesSummaryHtml(sub?.amenitiesText);
  const houseRules = escapeHtml(propertyTemplatePreview ? "" : sub?.houseRulesText?.trim() || "");
  const bathroomArrangement = propertyTemplatePreview
    ? ""
    : bathroomArrangementLeaseParagraph(subNorm, specificRoom?.id);
  const longTermBreakLeaseFee = resolveLongTermFeeAmount(
    sub?.longTermBreakLeaseFee,
    subNorm?.longTermBreakLeaseFee,
    config.defaultLongTermBreakLeaseFeeUsd,
  );
  const longTermLeaseUpFeePercent = resolveLongTermLeaseUpFeePercent(
    subNorm?.longTermLeaseUpFeePercent,
    sub?.longTermLeaseUpFeePercent !== undefined,
    config.defaultLongTermLeaseUpFeePercent,
  );
  const longTermHoldoverDailyRate = resolveLongTermFeeAmount(
    sub?.longTermHoldoverDailyRate,
    subNorm?.longTermHoldoverDailyRate,
    config.defaultLongTermHoldoverDailyUsd,
  );
  const longTermReturnedPaymentFee = parseAmount(subNorm?.longTermReturnedPaymentFee);
  const longTermDepositLaborRate = parseAmount(subNorm?.longTermDepositLaborRate);
  const longTermDepositReissueFee = parseAmount(subNorm?.longTermDepositReissueFee);
  const longTermTrashViolationFee = parseAmount(subNorm?.longTermTrashViolationFee);
  const longTermQuietHours = escapeHtml(propertyTemplatePreview ? "" : subNorm?.longTermQuietHours ?? "");
  const longTermGuestCap = propertyTemplatePreview ? undefined : subNorm?.longTermGuestCap;
  const longTermDisputeVenue = escapeHtml(propertyTemplatePreview ? "" : subNorm?.longTermDisputeVenue ?? "");
  const longTermProfessionalCleaningRequired = propertyTemplatePreview
    ? false
    : subNorm?.longTermProfessionalCleaningRequired === true;
  const hasConfiguredHoldover = !isMonthToMonthLease(a) && longTermHoldoverDailyRate != null && longTermHoldoverDailyRate > 0;
  const hasConfiguredEarlyTerminationTerm =
    (longTermBreakLeaseFee != null && longTermBreakLeaseFee > 0) || longTermLeaseUpFeePercent != null;
  const washingtonStyleEntry = config.landlordEntryStatuteRef?.includes("RCW") === true;
  const governingLawLabel = config.governingLawParagraph.includes("Washington")
    ? "Washington law"
    : "applicable law";
  const terminationFeeExhibitRows = [
    longTermBreakLeaseFee != null && longTermBreakLeaseFee > 0
      ? `  <tr><td>Break lease fee</td><td class="amount">${fmtUsd(longTermBreakLeaseFee)}</td><td>If early termination</td></tr>`
      : "",
    longTermLeaseUpFeePercent != null
      ? `  <tr><td>Lease-up fee (up to)</td><td class="amount">${longTermLeaseUpFeePercent}% of one month&apos;s rent</td><td>If early termination</td></tr>`
      : "",
    hasConfiguredHoldover
      ? `  <tr><td>Holdover after lease end</td><td class="amount">${fmtUsd(longTermHoldoverDailyRate)}</td><td>Per day</td></tr>`
      : "",
  ]
    .filter(Boolean)
    .join("\n");
  const petPolicy = propertyTemplatePreview
    ? "Pet policy is specified when a resident is placed at this property."
    : (room?.petFriendly ?? list?.petFriendly)
      ? "Pets may be permitted subject to prior written approval from Landlord, a separate pet deposit (amount specified in writing), and compliance with all house rules."
      : "No pets or animals of any kind are permitted on the Premises without prior written consent of Landlord.";
  const manualPaymentMethods = [
    sub?.zellePaymentsEnabled && sub.zelleContact?.trim()
      ? `Zelle to <strong>${escapeHtml(sub.zelleContact.trim())}</strong>`
      : "",
    sub?.venmoPaymentsEnabled && sub.venmoContact?.trim()
      ? `Venmo to <strong>${escapeHtml(sub.venmoContact.trim())}</strong>`
      : "",
  ].filter(Boolean);
  const paymentMethod = propertyTemplatePreview
    ? "Payment shall be made via the PropLane portal or by a method agreed in writing with Landlord."
    : manualPaymentMethods.length > 0
      ? `Payment may be made via Stripe (portal), ${manualPaymentMethods.join(", ")}, or another method agreed in writing.`
      : "Payment shall be made via the PropLane portal or by a method agreed in writing with Landlord.";

  const proratedSection = propertyTemplatePreview
    ? ""
    : proratedBlock(monthlyRentStr, utilitiesStr, a.leaseStart ?? "", a.leaseEnd ?? "", {
    method: specificRoom?.prorateMethod,
    dailyRentRate: specificRoom?.dailyRentRate,
    dailyUtilitiesRate: specificRoom?.dailyUtilitiesRate,
    utilitiesOnly: isDailyBasis,
    utilitiesAmount: utilitiesNum ?? 0,
    ledgerProratedRent: leaseBilling?.proratedRent,
    ledgerProratedUtilities: leaseBilling?.proratedUtilities,
  });

  if (stay.stayKind === "short") {
    const dailyCost = stay.dailyRate;
    // Same night count the ledger bills from. The previous inline math parsed
    // "YYYY-MM-DD" as UTC, which could land a day off from the charges.
    // Two ledger paths bill a "short" stay and they count days differently, so the document
    // has to follow whichever one applies. An EXPLICIT short-term application bills one
    // stay_total over checkout-exclusive nights. A daily-basis room on a standard application
    // bills first-month rent over intraMonthStaySpan's INCLUSIVE billable days. Using one
    // count for both put the agreement a night off from the charges.
    const stayNights = propertyTemplatePreview
      ? 0
      : a.rentalType === "short_term"
        ? shortTermStayNightCount(a.leaseStart, a.leaseEnd)
        : (intraMonthStaySpan(a.leaseStart, a.leaseEnd)?.billableDays ??
          shortTermStayNightCount(a.leaseStart, a.leaseEnd));
    const stayUnitNoun = a.rentalType === "short_term" ? "Night" : "Day";
    const dailyCostRaw = propertyTemplatePreview ? "—" : dailyCost !== undefined ? fmtUsd(dailyCost) : "—";
    const depositAmount = propertyTemplatePreview ? undefined : stay.deposit;
    const shortDepositRaw = propertyTemplatePreview ? "—" : depositAmount !== undefined ? fmtUsd(depositAmount) : "—";
    const totalRent =
      propertyTemplatePreview ? "—" : dailyCost && stayNights ? fmtUsd(shortTermStayTotalAmount(dailyCost, stayNights)) : "—";
    // The ledger bills more than rent + deposit on a stay, so the document has to list the
    // rest or its "Total due" understates what the guest owes. Which move-in field applies
    // follows rentalType, exactly as the ledger's two branches do.
    // Room-first, then the listing, matching the ledger. A room carrying its own short-term
    // move-in fee is charged that fee, so the agreement has to quote the same one.
    const stayMoveInLabel = propertyTemplatePreview
      ? ""
      : overrideFeeLabel(
          a.managerMoveInFeeOverride,
          (a.rentalType === "short_term"
            ? (specificRoom?.shortTermMoveInFee?.trim() || subNorm?.shortTermMoveInFee)
            : (specificRoom?.moveInFee?.trim() || subNorm?.moveInFee)) ?? "",
        );
    const stayMoveInNum = parseAmount(stayMoveInLabel) ?? 0;
    const stayOtherNum = showOtherSigningCost ? (otherCostNum ?? 0) : 0;
    // Utilities are billed alongside a standard-application stay but never on an explicit
    // short-term stay, whose nightly rate is all-in. The ledger PRORATES them across the
    // stay's span, so quoting the full monthly estimate here would overstate the total.
    // `rentBasis: "daily"` and `prorateMethod: "daily_rate"` are independent per-room fields
    // that can coexist, and the ledger prorates utilities by the room's own daily utilities
    // rate whenever it has one. Same two branches here, or the two totals diverge.
    const stayUtilitiesSpan = intraMonthStaySpan(a.leaseStart, a.leaseEnd);
    const stayUtilitiesBase = a.rentalType === "short_term" ? 0 : (utilitiesNum ?? 0);
    // The ledger only credits a paid holding deposit on its STANDARD branch; the explicit
    // short-term branch charges the full shortTermDeposit and returns before that code. So
    // the credit sentence is only true for a standard application, and printing it on an
    // explicit short-term agreement would assert a credit the resident never receives.
    // Keyed on rentalType, not stayKind, for exactly the same reason the deposit is.
    const holdingCreditApplies = a.rentalType !== "short_term";
    const stayDailyUtilitiesRate =
      specificRoom?.prorateMethod === "daily_rate" && (specificRoom.dailyUtilitiesRate ?? 0) > 0
        ? specificRoom.dailyUtilitiesRate!
        : 0;
    // A daily_rate room with NO per-day utilities rate bills ZERO utilities, not the monthly
    // estimate prorated: its listing folds utilities into the daily rent, so quoting the
    // estimate here would state a charge the resident never receives. The ledger has these
    // same three cases; collapsing them to two is what made the document disagree.
    const stayUtilitiesFolded =
      specificRoom?.prorateMethod === "daily_rate" && stayDailyUtilitiesRate <= 0;
    const stayUtilitiesNum =
      stayUtilitiesBase > 0 && stayUtilitiesSpan && !stayUtilitiesFolded
        ? stayDailyUtilitiesRate > 0
          ? Number((stayUtilitiesSpan.billableDays * stayDailyUtilitiesRate).toFixed(2))
          : Number((stayUtilitiesBase * (stayUtilitiesSpan.billableDays / stayUtilitiesSpan.daysInMonth)).toFixed(2))
        : 0;
    // Custom fees bill once before check-in, so they belong in the stay's Payment table.
    // WHICH amount is keyed on rentalType, exactly like the move-in fee, the utilities and
    // the deposit above: a stay can be "short" here while the application is standard (a
    // daily-priced room on a short-stay listing), and the ledger then bills the one-time
    // `amount`, never `shortTermAmount`. Reading the wrong one understates the total.
    const stayFeeAmount = (fee: { amount?: string; shortTermAmount?: string }) =>
      a.rentalType === "short_term" ? fee.shortTermAmount : fee.amount;
    const stCustomFees = propertyTemplatePreview
      ? []
      : (subNorm?.customFees ?? []).filter((fee) => {
      const presetId = (fee as { presetId?: string }).presetId;
      if (presetId && presetId !== "custom") return false;
      const n = parseAmount(stayFeeAmount(fee));
      return n != null && n > 0;
    });
    const stCustomFeesTotal = stCustomFees.reduce((s, f) => s + (parseAmount(stayFeeAmount(f)) ?? 0), 0);
    const stCustomFeeRows = stCustomFees
      .map(
        (f) =>
          `  <tr><th>${escapeHtml(f.label?.trim() || "Custom fee")}</th><td>${escapeHtml(fmtUsd(parseAmount(stayFeeAmount(f)) ?? 0))}</td></tr>`,
      )
      .join("\n");
    const totalDue = propertyTemplatePreview
      ? "—"
      : dailyCost && stayNights
        ? fmtUsd(
            shortTermStayTotalAmount(dailyCost, stayNights) +
              (depositAmount ?? 0) +
              stayMoveInNum +
              stayOtherNum +
              stayUtilitiesNum +
              stCustomFeesTotal,
          )
        : "—";
    const requirements = escapeHtml(
      propertyTemplatePreview
        ? "House rules and short-term requirements are filled when a guest is placed at this property."
        : subNorm?.shortTermRequirements?.trim() ||
            "Guest must follow all reasonable house rules provided by the Owner/Host. Guest may not receive mail, declare residency, or claim tenancy.",
    );
    const checkInTimeRaw = (a.shortTermCheckInTime ?? "").trim();
    const checkOutTimeRaw = (a.shortTermCheckOutTime ?? "").trim();
    const checkInDateTime = checkInTimeRaw ? `${leaseStart} @ ${escapeHtml(checkInTimeRaw)}` : leaseStart;
    const checkOutDateTime = checkOutTimeRaw
      ? `${leaseDate(a.leaseEnd)} @ ${escapeHtml(checkOutTimeRaw)}`
      : leaseDate(a.leaseEnd);

    return `<!doctype html><html><head><meta charset="utf-8"/><title>Short-Term Room Stay Agreement</title><style>${leaseCss()}</style></head><body>
${
  config.brandTitle
    ? `<h1>${escapeHtml(config.brandTitle)}</h1><p class="sub" style="font-weight:700;margin-bottom:0.15rem">SHORT-TERM ROOM STAY AGREEMENT${stayNights ? ` (${stayNights}-${stayUnitNoun} Stay)` : ""}</p>`
    : `<h1>SHORT-TERM ROOM STAY AGREEMENT${stayNights ? ` (${stayNights}-${stayUnitNoun} Stay)` : ""}</h1>`
}
<p class="sub">Owner-Occupied Residence · ${config.headerSubtitle}</p>
<p class="generated">Generated ${generatedDate} via PropLane</p>

<h2>1. Parties</h2>
<table>
  <tr><th width="35%">Owner / Host</th><td><strong>${landlordEntity}</strong></td></tr>
  <tr><th>Guest</th><td><strong>${tenantName}</strong><br/>Phone: ${tenantPhone} &nbsp;·&nbsp; Email: ${tenantEmail}</td></tr>
</table>

<h2>2. Property Address</h2>
<table>
  <tr><th width="35%">Property</th><td>${address}<br/>${escapeHtml(cityZip)}</td></tr>
  <tr><th>Room</th><td><strong>${roomLabel}</strong></td></tr>
  <tr><th>Description</th><td>${fullPremises}</td></tr>
</table>

<h2>3. Length of Stay</h2>
<table>
  <tr><th width="35%">Check-in date &amp; time</th><td>${checkInDateTime}</td></tr>
  <tr><th>Check-out date &amp; time</th><td>${checkOutDateTime}</td></tr>
  <tr><th>Total duration</th><td>${stayNights ? `${stayNights} ${stayUnitNoun.toLowerCase()}${stayNights === 1 ? "" : "s"}` : "—"}</td></tr>
</table>

<h2>4. Payment</h2>
<table class="fee-table">
  <tr><th width="35%">Daily rent</th><td>${escapeHtml(dailyCostRaw)} per day</td></tr>
  <tr><th>Total rent for stay</th><td>${totalRent}</td></tr>
  <tr><th>Deposit</th><td>${escapeHtml(shortDepositRaw)}</td></tr>
  ${stayUtilitiesNum > 0 && stayUtilitiesSpan ? `<tr><th>Utilities estimate (${stayUtilitiesSpan.billableDays}/${stayUtilitiesSpan.daysInMonth} days)</th><td>${fmtUsd(stayUtilitiesNum)}</td></tr>` : ""}
  ${stayMoveInLabel ? `<tr><th>Move-in fee</th><td>${escapeHtml(stayMoveInLabel)}</td></tr>` : ""}
  ${stayOtherNum > 0 ? `<tr><th>${otherCostLabel}</th><td>${fmtUsd(stayOtherNum)}</td></tr>` : ""}
${stCustomFeeRows}
  <tr class="total-row"><th>Total due</th><td class="amount"><strong>${totalDue}</strong></td></tr>
</table>
${paySigningIncludesNote ? `<p class="fee-note">Amounts due before check-in follow the listing&apos;s payment-at-signing settings (${paySigningIncludesNote}).</p>` : ""}
${holdingCreditApplies ? `<p>${HOLDING_DEPOSIT_CREDIT_NOTE}</p>` : ""}

<h2>5. Lodger Status</h2>
<p>${config.shortTermPurposeParagraph}</p>

<h2>6. House Rules &amp; Short-Term Requirements</h2>
<p>${requirements}</p>
${houseRules ? `<p>${houseRules}</p>` : ""}

<h2>7. Entry</h2>
${
  washingtonStyleEntry
    ? `<p>Landlord may enter the private room after providing notice required under Washington law for inspections, repairs, maintenance, or showing the room.</p>
<p>Landlord may enter immediately without prior notice during emergencies involving health, safety, or protection of property.</p>
<p>Landlord and authorized representatives may access shared/common areas at any time for purposes including maintenance, inspections, cleaning, repairs, safety checks, or management of the property. Residents do not have exclusive possession of shared areas.</p>`
    : `<p>Landlord or Landlord&apos;s authorized agents may enter the private room after providing reasonable advance written notice for inspections, repairs, maintenance, or showings, as required by applicable law.</p>
<p>Landlord may enter immediately without prior notice during emergencies involving health, safety, or protection of property.</p>
<p>Landlord and authorized representatives may access shared/common areas at any time for maintenance, inspections, cleaning, repairs, safety checks, or management of the property. Guests do not have exclusive possession of shared areas.</p>`
}

<h2>8. No Right to Remain After Check-Out</h2>
<p>Guest must vacate the room and property by the check-out date and time. If Guest refuses to leave, Guest may be treated as a trespasser to the fullest extent permitted by law.${
  hasConfiguredHoldover
    ? ` Any continued occupancy after check-out shall be charged <strong>${fmtUsd(longTermHoldoverDailyRate)} per day</strong>.`
    : ""
}</p>

<h2>9. Revocation of Permission</h2>
<p>Guest occupies the room by permission of the Owner/Host, not under a tenancy. To the extent permitted by applicable law, Owner/Host may revoke that permission for conduct that endangers persons or property, violates the house rules, or breaches this agreement, and Guest must then leave the property.</p>
<p>If Guest does not leave after permission is revoked or after the check-out time, Owner/Host may contact law enforcement to remove Guest, to the fullest extent permitted by applicable law. Nothing in this section waives any right Guest may have under law that applies to this stay.</p>

<h2>10. Damages and Liability</h2>
<p>Guest is responsible for any loss or damage to the room, shared areas, furnishings, or the property caused by Guest or by anyone Guest permits on the property, beyond ordinary wear from the agreed use. To the extent permitted by applicable law, Owner/Host may recover the cost of repair, replacement, or cleaning.</p>
<p>Guest is responsible for insuring Guest's own belongings. To the extent permitted by applicable law, Owner/Host is not liable for loss, theft, or damage to Guest's personal property except to the extent caused by Owner/Host's own negligence or as otherwise required by law. Nothing in this section waives any right Guest may have under law that applies to this stay.</p>

<h2>11. Shared Residence</h2>
<p>Owner/Host lives on or controls the property. Guest is renting a room only and receives only temporary shared-area access as approved by Owner/Host.</p>

<h2>12. No Mail / No Residency</h2>
<p>Guest may not receive mail, declare residency, or claim tenancy at the property. Guest may not use the property address for government ID, voter registration, banking, employment, delivery accounts, or similar residency purposes.</p>

<h2>13. Condition of Room</h2>
<p>Guest agrees to leave the room and shared areas in clean, undamaged condition. Owner/Host may deduct unpaid amounts, cleaning costs, missing items, or damage beyond ordinary use from the deposit.</p>

<h2>14. Electronic Signature</h2>
<p>Owner/Host and Guest each sign this agreement <strong>once</strong> through the PropLane portal. The <strong>Electronic Signature Certificate</strong> at the end of the signed document is the official record of both signatures. No handwritten signature blocks appear here.</p>
${customTermsAddendumHtml(subNorm, "Additional Provisions from Owner/Host", propertyTemplatePreview)}
</body></html>`;
  }

  const lateFeeUsd = propertyTemplatePreview
    ? null
    : sub?.lateFeeEnabled === false
      ? null
      : (parseAmount(sub?.lateFeeAmount) ?? config.defaultLateFeeUsd);
  const billing = ctx.leaseBilling;
  const summaryMonthlyRent = billing ? fmtUsd(billing.monthlyRent) : escapeHtml(monthlyRentBaseStr);
  const summaryMonthlyUtilities = billing ? fmtUsd(billing.monthlyUtilities) : utilitiesStr;
  const summaryTotalMonthly = billing ? fmtUsd(billing.monthlyRent + billing.monthlyUtilities) : totalMonthly;
  const firstPartialMonthPayment = billing
    ? (billing.proratedRent ?? 0) + (billing.proratedUtilities ?? 0)
    : 0;
  const leaseSummaryHtml =
    config.brandTitle && billing
      ? `<div style="border:1px solid #999;padding:12px 14px;margin:0 0 1.25rem;background:#fafafa">
  <p style="margin:0 0 0.5rem;font-weight:700;text-align:center">Lease Summary</p>
  <table class="fee-table">
    <tr><th width="40%">Landlord</th><td>${landlordEntity}</td></tr>
    <tr><th>Resident</th><td>${tenantName}</td></tr>
    <tr><th>Premises</th><td>${roomLabel}, ${address}${cityZip ? `, ${escapeHtml(cityZip)}` : ""}</td></tr>
    <tr><th>Lease term</th><td>${leaseStart} – ${leaseEnd} (${leaseTerm})</td></tr>
    <tr><th>Monthly rent</th><td class="amount"><strong>${summaryMonthlyRent}</strong></td></tr>
    <tr><th>Monthly utilities</th><td class="amount"><strong>${summaryMonthlyUtilities}</strong></td></tr>
    ${summaryTotalMonthly ? `<tr class="total-row"><th>Total monthly payment</th><td class="amount"><strong>${summaryTotalMonthly}</strong></td></tr>` : ""}
    ${firstPartialMonthPayment > 0 ? `<tr><th>First partial month payment</th><td class="amount">${fmtUsd(firstPartialMonthPayment)}</td></tr>` : ""}
    <tr><th>Security deposit</th><td class="amount">${secDep}</td></tr>
    <tr><th>Move-in fee</th><td class="amount">${moveInFee}</td></tr>
    <tr class="total-row"><th>Payment due at signing</th><td class="amount"><strong>${paySigning}</strong></td></tr>
  </table>
  ${paySigningIncludesNote ? `<p class="fee-note">Due at signing includes: ${paySigningIncludesNote}.</p>` : ""}
</div>`
      : "";

  // Long-form section numbers are COUNTED, not written down. Every heading used to carry a
  // hand-computed expression over which optional sections were present, so adding one more
  // optional clause meant editing the number on every heading below it and getting a wrong
  // section number onto a legal document if you missed one. The body literal below evaluates
  // left to right, so a counter is exact. `recordSection` also stores a number that later body
  // text cross-references by name, instead of repeating the arithmetic.
  let sectionCounter = 0;
  const sectionRefs: Record<string, number> = {};
  const nextSection = (key?: string): number => {
    sectionCounter += 1;
    if (key) sectionRefs[key] = sectionCounter;
    return sectionCounter;
  };

  const longTermTitleHtml = config.brandTitle
    ? `<h1>${escapeHtml(config.brandTitle)}</h1>
<p class="sub" style="font-size:1.05rem;font-weight:700;margin-bottom:0.25rem">RESIDENTIAL LEASE AGREEMENT</p>
<p class="sub">${escapeHtml(config.headerSubtitle)}</p>`
    : `<h1>RESIDENTIAL ROOM RENTAL AGREEMENT</h1>
<p class="sub">${escapeHtml(config.headerSubtitle)}</p>`;

  const body = `
${longTermTitleHtml}
<p class="generated">Generated ${generatedDate} via PropLane</p>
${leaseSummaryHtml}
${disclosureReviewNotice}

<h2>${nextSection()}. Parties</h2>
<table>
  <tr><th width="35%">Landlord / Operator</th><td><strong>${landlordEntity}</strong>${landlordPropertyLine}<br/>Mailing address: ${landlordMailing}<br/>For notices, use PropLane portal messaging or the address above.</td></tr>
  <tr><th>Resident / Tenant</th><td><strong>${tenantName}</strong><br/>Phone: ${tenantPhone} &nbsp;·&nbsp; Email: ${tenantEmail}<br/>Date of birth: ${tenantDob}</td></tr>
</table>
${jointPartiesNote ? `<p>${jointPartiesNote}</p>` : ""}

<h2>${nextSection()}. Premises</h2>
<p>Landlord leases to Resident the following private room and appurtenant shared-area rights:</p>
<table>
  <tr><th width="35%">Property / building</th><td>${landlordEntity}</td></tr>
  <tr><th>Street address</th><td>${address}</td></tr>
  <tr><th>City / ZIP</th><td>${escapeHtml(cityZip)}</td></tr>
  <tr><th>Room / unit</th><td><strong>${roomLabel}</strong></td></tr>
  <tr><th>Full description</th><td>${fullPremises}</td></tr>
</table>
${config.municipalComplianceParagraph ? `<p>${escapeHtml(config.municipalComplianceParagraph)}</p>` : ""}
${premisesBaseDisclosureHtml}
${premisesDisclosureHtml}

<h2>${nextSection()}. Lease Term</h2>
${
  isMonthToMonthLease(a)
    ? `<p>The initial term is <strong>${leaseTerm}</strong>, beginning <strong>${leaseStart}</strong> and ending <strong>${leaseEnd}</strong>. ${leaseTermsBody}</p>
<p>This tenancy is month-to-month and continues under the agreed terms until lawfully ended. Either party may provide written notice to terminate ${config.monthToMonthTerminationNotice ?? "within the period required by applicable law"}.</p>`
    : `<p>This is a fixed-term lease beginning <strong>${leaseStart}</strong> and ending <strong>${leaseEnd}</strong> (${leaseTerm}). ${leaseTermsBody}</p>
<p>This Agreement automatically terminates at the end of the lease term and does not convert to a month-to-month tenancy unless both parties agree in writing.</p>
<p>Resident agrees to vacate the Premises no later than <strong>12:00 PM</strong> on the final day of the lease term.${
      hasConfiguredHoldover
        ? ` Any continued occupancy after termination shall be charged <strong>${fmtUsd(longTermHoldoverDailyRate)} per day</strong>.`
        : ""
    }</p>`
}
<p>Landlord will use commercially reasonable efforts to deliver possession on the commencement date. If possession is delayed by a prior occupant, casualty, government order, or another event outside Landlord's reasonable control, rent will abate until possession is delivered and either party may exercise any remedy required by applicable law.</p>

<h2>${nextSection("rent")}. Rent</h2>
<table>
  <tr><th width="50%">${rentRowLabel}</th><td><strong>${escapeHtml(monthlyRentBaseStr)}</strong></td></tr>
  <tr><th>Utilities / services (monthly estimate)</th><td><strong>${utilitiesStr}</strong></td></tr>
  ${totalMonthly ? `<tr class="total-row"><th>Total monthly payment</th><td><strong>${totalMonthly}</strong></td></tr>` : ""}
</table>
${isDailyBasis ? `<p>Rent for this Premises is charged <strong>by the day</strong>. Each month's rent is the actual number of days of the term falling in that month multiplied by the daily base rent above. No fixed monthly rent total applies. The utilities estimate is billed monthly and is prorated for any partial month.</p>` : ""}
<p>Rent is due on the <strong>1st calendar day</strong> of each month. ${paymentMethod}</p>
${lateFeeUsd != null ? `<p><strong>Late fee:</strong> If rent is not received after the listing's configured grace period, a late fee of <strong>${fmtUsd(lateFeeUsd)}</strong> (non-refundable) may be assessed. Acceptance of late payment does not waive Landlord&apos;s right to enforce late fees or pursue other remedies under this Agreement or applicable law.</p>` : ""}
${rentDisclosureHtml}

${proratedSection ? proratedSection.replace(PRORATED_SECTION_TOKEN, String(nextSection())) : ""}

<h2>${nextSection()}. Security Deposit &amp; Move-In Charges</h2>
<table class="fee-table">
  <tr><th width="50%">Application fee</th><td class="amount">${appFee}</td></tr>
  <tr><th>Security deposit</th><td class="amount"><strong>${secDep}</strong></td></tr>
  <tr><th>Move-in fee (non-refundable)</th><td class="amount">${moveInFee}</td></tr>
  ${showOtherSigningCost ? `<tr><th>${otherCostLabel}</th><td class="amount">${otherCostAmount}</td></tr>` : ""}
${customFeeSigningRows}
  <tr class="total-row"><th>Total due at signing</th><td class="amount"><strong>${paySigning}</strong></td></tr>
</table>
${paySigningIncludesNote ? `<p class="fee-note">Due at signing includes: ${paySigningIncludesNote}.</p>` : ""}
<p>${HOLDING_DEPOSIT_CREDIT_NOTE}</p>
<p>Resident shall pay a security deposit of <strong>${secDep}</strong> at lease signing. The deposit shall be held in accordance with ${config.depositStatuteRef} and secures Resident&apos;s full performance under this Agreement. Resident&apos;s liability is not limited to the deposit amount, and the deposit may not be applied toward rent or other charges during the tenancy.</p>
<p>${config.depositReturnWindow ?? "Within the period required by applicable law after termination of the tenancy and vacancy of the Premises"}, Landlord shall return any refundable portion of the deposit or provide a written itemized statement of deductions, as required by law. Resident shall provide a forwarding address for delivery of the deposit accounting and any refund. Any refund may be issued as a single check payable to all Residents.</p>
<p>Deductions from the deposit may include, to the extent permitted by law:</p>
<ul>
  <li>Unpaid rent, utilities, or other charges.</li>
  <li>Cleaning and restoration beyond ordinary wear and tear.</li>
  <li>Repair or replacement of missing or damaged property, fixtures, or keys.</li>
  <li>Fees or charges due under this Agreement (including early termination).</li>
  <li>${longTermDepositLaborRate != null && longTermDepositLaborRate > 0 ? `Reasonable labor costs at <strong>${fmtUsd(longTermDepositLaborRate)} per hour</strong> or third-party actual cost.` : "Reasonable and documented labor or third-party costs."}</li>
</ul>
${longTermDepositReissueFee != null && longTermDepositReissueFee > 0 ? `<p>A <strong>${fmtUsd(longTermDepositReissueFee)}</strong> stop-payment or reissuance fee may be deducted if a refund must be reissued due to an incorrect or missing address, where permitted by law.</p>` : ""}
${depositDisclosureHtml}

<h2>${nextSection()}. Returned Payments</h2>
<p>If any payment is dishonored, reversed, or returned unpaid, Resident shall promptly pay the original amount due and any actual bank or processing charges.${longTermReturnedPaymentFee != null && longTermReturnedPaymentFee > 0 ? ` A returned-payment fee of <strong>${fmtUsd(longTermReturnedPaymentFee)}</strong> may also be charged${config.returnedPaymentStatuteRef ? ` subject to ${escapeHtml(config.returnedPaymentStatuteRef)}` : ""}.` : ""} Repeated returned payments may require future payment by certified funds or another method approved in writing by Landlord.</p>

<h2>${nextSection("utilities")}. Utilities &amp; Services</h2>
${utilitiesBreakdown}
<p>The estimated monthly utilities / RUBS charge is <strong>${utilitiesStr}</strong>. ${utilitiesEstimateSentence} The actual charge may vary based on usage. Resident shall not engage in unusual or wasteful energy use. Landlord reserves the right to bill excess usage directly to Resident with 30 days' advance written notice of a change in the utility structure.</p>
${longTermTrashViolationFee != null && longTermTrashViolationFee > 0 ? `<p><strong>Trash rules:</strong> Resident must bag trash, use designated containers, break down boxes, and keep trash and recyclables out of hallways. A documented violation may result in a <strong>${fmtUsd(longTermTrashViolationFee)}</strong> fee per occurrence, to the extent permitted by applicable law.</p>` : ""}
<p>Resident remains responsible for cleaning up after personal use of shared spaces and providing reasonable access for scheduled cleaning services.</p>
${utilitiesDisclosureHtml}

<h2>${nextSection("useOccupancy")}. Use, Occupancy &amp; Guest Policy</h2>
<p>The Premises shall be used exclusively as a private residence. The only authorized occupant is <strong>${tenantName}</strong>. No other person may reside in or occupy the Premises without Landlord&apos;s prior written consent.</p>
<ul>
  <li><strong>Guests:</strong> ${longTermGuestCap ? `Gatherings of more than ${longTermGuestCap} guests require Landlord's prior written approval.` : "No guest is permitted on the property or in the room unless Landlord gives prior written approval in advance."}</li>
  <li><strong>No short-term rentals:</strong> Listing the room on Airbnb, VRBO, or any similar platform is strictly prohibited and constitutes grounds for immediate termination.</li>
  <li><strong>Business use:</strong> No commercial, business, or professional activity that generates client visits or deliveries is permitted.</li>
  <li><strong>Illegal activity:</strong> No illegal activity of any kind on or near the Premises.</li>
</ul>

<h2>${nextSection()}. Shared Spaces</h2>
${sharedSpacesHtml}
${bathroomArrangement ? `<p><strong>Bathroom arrangement:</strong> ${escapeHtml(bathroomArrangement)}</p>` : ""}
<p><strong>Building amenities (summary):</strong> ${amenitiesHtml}</p>

<h2>${nextSection()}. House Rules</h2>
${houseRules
  ? `<p>${houseRules}</p>`
  : `<ul>
  ${longTermQuietHours ? `<li><strong>Quiet hours:</strong> ${longTermQuietHours}. No loud music, TV, or gatherings that disturb other residents during these hours.</li>` : ""}
  <li><strong>Kitchen &amp; dining:</strong> Clean dishes, pots, and counters after each use within 24 hours. Label personal food. No leaving dirty dishes overnight.</li>
  <li><strong>Bathroom:</strong> Keep assigned bathroom clean. Wipe surfaces after use. Remove personal items from shared spaces.</li>
  <li><strong>Trash:</strong> Bag all trash and place in designated containers. Follow the posted schedule for curbside collection.</li>
  <li><strong>Common areas:</strong> Vacuum / mop per posted schedule. Do not leave personal belongings in common areas for more than 24 hours.</li>
  <li><strong>Smoking:</strong> Smoking, vaping, and cannabis use are prohibited inside the property and within 25 feet of any door or window.</li>
  <li><strong>Noise &amp; conflict:</strong> Disputes between residents should be addressed respectfully. Persistent nuisance behavior is grounds for lease termination.</li>
</ul>`}
${houseRules && longTermQuietHours ? `<p><strong>Quiet hours:</strong> ${longTermQuietHours}. No loud music, TV, or gatherings that disturb other residents during these hours.</p>` : ""}
${houseRulesDisclosureHtml}

<h2>${nextSection()}. Pets</h2>
<p>${escapeHtml(petPolicy)}</p>
<p>Pet disclosure on application: <strong>${pets}</strong>.</p>

<h2>${nextSection()}. Maintenance &amp; Repairs</h2>
<h3>Landlord responsibilities${config.landlordMaintenanceStatuteRef ? ` (${config.landlordMaintenanceStatuteRef})` : ""}:</h3>
<ul>
  <li>Maintain the dwelling in a structurally sound, weathertight, and sanitary condition.</li>
  <li>Provide adequate heating capable of maintaining ${config.minimumHeatTemperature ?? "the minimum temperature required by applicable law"} and functioning plumbing and hot water.</li>
  <li>Keep common areas clean, sanitary, and reasonably free from pests.</li>
  <li>Maintain all electrical, plumbing, heating, and mechanical systems in good working order.</li>
  <li>Respond to emergency repair requests (no heat, water, major leak) within 24 hours; non-emergency repairs within a reasonable timeframe, generally 10 business days.</li>
</ul>
<h3>Resident responsibilities (${config.residentMaintenanceStatuteRef}):</h3>
<ul>
  <li>Keep the room and areas under Resident's control clean, sanitary, and free of garbage.</li>
  <li>Replace light bulbs, batteries in smoke/CO detectors, and HVAC filters (if in-room) as needed.</li>
  <li>Clear drains of hair and debris; do not flush non-flushable items.</li>
  <li>Promptly report any mold, moisture, leaks, pests, or damage to Landlord in writing via the PropLane portal.</li>
  <li>Not damage, destroy, or remove any part of the premises, appliances, or fixtures.</li>
  <li>Keep the room ventilated to prevent mold growth; report visible mold within 24 hours.</li>
  <li>In emergency (fire, gas leak, flooding), call 911 first, then notify Landlord immediately.</li>
</ul>
<h3>Safety devices and fire safety:</h3>
<ul>
  <li>Resident shall not remove or disable smoke alarms${config.smokeAlarmStatuteRef ? ` (${escapeHtml(config.smokeAlarmStatuteRef)})` : ""} or carbon monoxide alarms${config.carbonMonoxideAlarmStatuteRef ? ` (${escapeHtml(config.carbonMonoxideAlarmStatuteRef)})` : ""}, shall replace batteries where appropriate, and shall promptly report malfunctions.</li>
  <li>Resident shall keep means of egress clear, shall not alter water-heater controls, and shall follow posted fire-safety requirements.</li>
</ul>
<h3>Alterations:</h3>
<p>Resident shall not paint, drill, install fixtures, or make any alterations without prior written approval. Unauthorized alterations must be restored at Resident's expense at move-out.</p>

<h2>${nextSection()}. Entry (${config.landlordEntryStatuteRef})</h2>
${
  washingtonStyleEntry
    ? `<p>Landlord may enter the private room after providing notice required under Washington law for inspections, repairs, maintenance, or showing the room.</p>
<p>Landlord may enter immediately without prior notice during emergencies involving health, safety, or protection of property.</p>
<p>Landlord and authorized representatives may access shared/common areas at any time for purposes including maintenance, inspections, cleaning, repairs, safety checks, or management of the property. Residents do not have exclusive possession of shared areas.</p>`
    : `<p>Landlord or Landlord's authorized agents may enter the private room after providing at least <strong>24 hours' advance written notice</strong> (email to Resident's address of record shall suffice) for the purpose of inspections, repairs, improvements, or showing to prospective tenants or buyers. Entry shall be at reasonable times unless agreed otherwise.</p>
<p>In case of <strong>emergency</strong> (fire, flood, gas leak, or other imminent hazard), Landlord may enter without notice. After an emergency entry, Landlord shall provide written notice to Resident as soon as reasonably practicable.</p>
<p>Landlord and authorized representatives may access shared/common areas at any time for maintenance, inspections, cleaning, repairs, safety checks, or management of the property. Residents do not have exclusive possession of shared areas.</p>`
}

<h2>${nextSection()}. Assignment &amp; Subletting</h2>
<p>Resident may not assign this lease, sublet the room, or accommodate any occupant not authorized in Section ${sectionRefs.useOccupancy} without prior written consent of Landlord. Consent shall not be unreasonably withheld where Resident provides a qualified replacement tenant. Any unauthorized subletting, including short-term rentals, constitutes material breach.</p>

${longTermProfessionalCleaningRequired ? `<h2>${nextSection()}. Move-Out &amp; Surrender</h2>
<p>At move-out, Resident shall vacate, remove personal property, return all keys and access devices, and surrender the Premises in substantially the same condition as received, ordinary wear and tear excepted. Resident must complete professional cleaning and provide a paid invoice. If Resident does not do so, Landlord may arrange professional cleaning after vacancy and include the documented invoice in any lawful deposit deduction.</p>` : ""}

<h2>${nextSection()}. Renter's Insurance</h2>
<p>Resident is <strong>strongly encouraged</strong> to maintain renter's insurance with personal-liability coverage. Landlord's property insurance does <em>not</em> cover Resident's personal belongings or liability. Landlord is not liable for theft, fire, water damage, or loss of Resident's personal property.</p>

<h2>${nextSection()}. Default &amp; Remedies</h2>
<p>A material breach includes but is not limited to: nonpayment of rent or fees, unauthorized occupants, violation of house rules, illegal activity, or substantial damage to the Premises. Upon material breach:</p>
<ul>
  <li>Landlord shall provide written notice to cure or vacate per ${config.defaultNoticeStatuteRef} (3-day pay-or-vacate for nonpayment; 10-day cure notice for other violations).</li>
  <li>If uncured, Landlord may pursue eviction (unlawful detainer), monetary damages, and attorneys' fees.</li>
  <li>Resident remains liable for rent through the end of the lease term or until a qualified replacement tenant begins paying rent, whichever occurs first.</li>
</ul>
${defaultDisclosureHtml}

<h2>${nextSection()}. Early Termination</h2>
${
  hasConfiguredEarlyTerminationTerm
    ? `<p>If Resident vacates prior to lease expiration or without proper notice, Resident shall be liable for:</p>
<ul>
  ${longTermBreakLeaseFee != null && longTermBreakLeaseFee > 0 ? `<li>A break lease fee of <strong>${fmtUsd(longTermBreakLeaseFee)}</strong></li>` : ""}
  ${longTermLeaseUpFeePercent != null ? `<li>A prorated lease-up fee of up to <strong>${longTermLeaseUpFeePercent}% of one month&apos;s rent</strong></li>` : ""}
  <li>Ongoing rent, utilities, and recurring charges until a replacement resident takes possession or the lease term ends (whichever occurs first)${
      config.earlyTerminationStatuteRef ? `, in accordance with ${escapeHtml(config.earlyTerminationStatuteRef)}` : ""
    }</li>
  <li>Any difference between the replacement rent and the rent under this Agreement</li>
  <li>All actual re-renting costs, including court costs and reasonable attorneys&apos; fees</li>
</ul>
<p>If Resident breaks the lease without Landlord&apos;s written consent, Resident shall also be liable for actual damages and unpaid obligations permitted by ${escapeHtml(
        governingLawLabel,
      )}, including unpaid rent through the earlier of the lease end date or the date a replacement resident takes possession.</p>`
    : "<p>Any early termination is governed by applicable law and a written agreement between the parties.</p>"
}

<h2>${nextSection()}. Payment Application Order</h2>
<p>Any payments received shall be applied in the following order: (1) outstanding damage charges; (2) outstanding utility charges; (3) late fees and administrative fees; (4) past due rent (oldest first); (5) current rent.</p>

<h2>${nextSection()}. Notices</h2>
<p>All notices shall be in writing. Delivery by email to the address on file or via PropLane portal messaging is acceptable and shall be deemed received upon sending during business hours. Legal notices may also be delivered in person or by first-class mail to the mailing addresses listed in Section 1. Either party may update their notice address in writing.</p>
${noticesDisclosureHtml}

${statutoryDisclosureHtml ? `<h2>${nextSection()}. Statutory Disclosures</h2>\n${statutoryDisclosureHtml}` : ""}

${leadDisclosureHtml ? `<h2>${nextSection()}. Lead-Based Paint Disclosure</h2>\n${leadDisclosureHtml}` : ""}

<h2>${nextSection()}. Governing Law; Severability; Entire Agreement</h2>
<p>${config.governingLawParagraph}</p>
${longTermDisputeVenue ? `<p>Venue for a dispute arising from this Agreement is ${longTermDisputeVenue}, to the extent permitted by applicable law.</p>` : ""}

<h2>${nextSection()}. Attorney Fees</h2>
<p>In any action to enforce or interpret this Agreement, the prevailing party shall be entitled to recover reasonable attorney fees and court costs as permitted by law.</p>

<h2>${nextSection()}. Application Summary (Incorporated by Reference)</h2>
<table>
  <tr><th>Field</th><th>Information supplied by Resident</th></tr>
  <tr><td>Full legal name</td><td>${tenantName}</td></tr>
  <tr><td>Date of birth</td><td>${tenantDob}</td></tr>
  <tr><td>Phone</td><td>${tenantPhone}</td></tr>
  <tr><td>Email</td><td>${tenantEmail}</td></tr>
  <tr><td>Employer</td><td>${employer}</td></tr>
  <tr><td>Title / role</td><td>${jobTitle}</td></tr>
  <tr><td>Monthly income (stated)</td><td>${monthlyIncome}</td></tr>
  <tr><td>Current address</td><td>${dash(a.currentStreet)}, ${dash(a.currentCity)}, ${dash(a.currentState)} ${dash(a.currentZip)}</td></tr>
  <tr><td>Reference 1</td><td>${dash(a.ref1Name)}</td></tr>
  <tr><td>Reference 2</td><td>${dash(a.ref2Name)}</td></tr>
  <tr><td>Pets / animals</td><td>${pets}</td></tr>
  <tr><td>Household size</td><td>${occupancy}</td></tr>
</table>

<h2>${nextSection()}. Rent &amp; Fees Schedule (Exhibit A)</h2>
<table class="fee-table">
  <tr><th>Item</th><th>Amount</th><th>Frequency</th></tr>
  <tr><td>${rentRowLabel}</td><td class="amount"><strong>${escapeHtml(typeof monthlyRentStr === "string" ? monthlyRentStr : String(monthlyRentStr))}</strong></td><td>${isDailyBasis ? "Per day, billed each month by actual days" : "Monthly, due 1st"}</td></tr>
  <tr><td>Utilities / services estimate</td><td class="amount">${utilitiesStr}</td><td>Monthly</td></tr>
  ${totalMonthly ? `<tr class="total-row"><td><strong>Total monthly payment</strong></td><td class="amount"><strong>${totalMonthly}</strong></td><td>Monthly</td></tr>` : ""}
  <tr><td>Application fee</td><td class="amount">${appFee}</td><td>One-time</td></tr>
  <tr><td>Security deposit</td><td class="amount">${secDep}</td><td>One-time (refundable)</td></tr>
  <tr><td>Move-in fee</td><td class="amount">${moveInFee}</td><td>One-time (non-refundable)</td></tr>
  ${showOtherSigningCost ? `<tr><td>${otherCostLabel}</td><td class="amount">${otherCostAmount}</td><td>One-time</td></tr>` : ""}
${customFeeExhibitRows}
${terminationFeeExhibitRows}
  <tr class="total-row"><td><strong>Total due at signing</strong></td><td class="amount"><strong>${paySigning}</strong></td><td>At signing</td></tr>
</table>
${paySigningIncludesNote ? `<p class="fee-note">Due at signing includes: ${paySigningIncludesNote}.</p>` : ""}

<h2>${nextSection()}. Electronic Signature</h2>
<p><strong>Landlord / Authorized Agent</strong> and <strong>Resident / Tenant</strong> each execute this Agreement <strong>one time</strong> through the PropLane portal (one manager signature and one resident signature). The <strong>Electronic Signature Certificate</strong> appended to the signed copy is the binding record for both parties. No duplicate handwritten signature lines are included in this document.</p>

<!-- ═══════════════════════════════════════════════════════════════════════ -->
<div class="addendum page-break">
<h2>Addendum A — Move-In Condition Report</h2>
<p>Resident and Landlord may complete and sign this report after move-in. A signed report, including any dated photographs or video recordings, supersedes this baseline acknowledgement for documenting move-in condition.</p>
<table>
  <tr><th>Area / item</th><th>Condition at move-in</th><th>Notes</th></tr>
  <tr><td>Room walls / paint</td><td>&nbsp;</td><td>&nbsp;</td></tr>
  <tr><td>Floors / carpet</td><td>&nbsp;</td><td>&nbsp;</td></tr>
  <tr><td>Windows / blinds</td><td>&nbsp;</td><td>&nbsp;</td></tr>
  <tr><td>Door / lock</td><td>&nbsp;</td><td>&nbsp;</td></tr>
  <tr><td>Closet</td><td>&nbsp;</td><td>&nbsp;</td></tr>
  <tr><td>Lighting / outlets</td><td>&nbsp;</td><td>&nbsp;</td></tr>
  <tr><td>Bathroom (if assigned)</td><td>&nbsp;</td><td>&nbsp;</td></tr>
  <tr><td>Kitchen access</td><td>&nbsp;</td><td>&nbsp;</td></tr>
  <tr><td>Common area general</td><td>&nbsp;</td><td>&nbsp;</td></tr>
  <tr><td>Other / notes</td><td colspan="2">&nbsp;</td></tr>
</table>
<p>When you sign this Agreement in the PropLane portal, those electronic signatures apply to this checklist as well. No separate signature lines are required on this page.</p>
${moveInDisclosureHtml}
</div>

<div class="addendum">
<h2>Addendum B — Bed Bug Disclosure</h2>
<p>Landlord discloses that, to Landlord's knowledge as of the date of this Agreement, there is <strong>no known active bed bug infestation</strong> in the unit or building. Resident shall inspect the room upon move-in and report any signs of bed bugs immediately. If an infestation is discovered during the tenancy, Resident shall notify Landlord in writing within 24 hours and cooperate with any required inspection or treatment. Resident shall not introduce second-hand mattresses, upholstered furniture, or bedding without prior written approval. Resident is responsible for infestation caused by Resident's belongings or guests.</p>
${bedBugDisclosureHtml}
</div>

<div class="addendum">
<h2>Addendum C — Mold &amp; Moisture Policy</h2>
<p>Resident agrees to maintain adequate ventilation in the room and bathroom (open windows when possible, use exhaust fans). Resident shall promptly report visible mold, moisture intrusion, or condensation to Landlord in writing. Resident shall wipe down surfaces subject to moisture (shower walls, windowsills) regularly. Resident shall not dry laundry inside the room or any space without adequate ventilation. Failure to report mold or moisture conditions within 24 hours of discovery may result in Resident being held liable for resulting damage (${escapeHtml(config.residentMaintenanceStatuteRef)}).</p>
${moldDisclosureHtml}
</div>

<div class="addendum">
<h2>Addendum D — Maintenance &amp; Tenant Responsibilities Detail</h2>
<ul>
  <li><strong>Light bulbs:</strong> Resident is responsible for replacing standard bulbs in their room.</li>
  <li><strong>Smoke &amp; CO detectors:</strong> Test monthly; replace batteries as needed; never disable. Report any malfunctioning detector within 24 hours.</li>
  <li><strong>HVAC filters (in-room):</strong> Replace or clean as recommended by Landlord, typically every 60–90 days.</li>
  <li><strong>Drains:</strong> Keep shower/sink drains free of hair and debris. Use drain covers. Do not pour grease down any drain.</li>
  <li><strong>Appliances:</strong> Report any malfunction immediately. Do not attempt to repair appliances. Clean appliances (microwave, oven) after each use.</li>
  <li><strong>Damage reporting:</strong> Report all damage, leaks, pests, or safety hazards to Landlord via the PropLane portal within 24 hours of discovery.</li>
  <li><strong>Emergencies:</strong> In the event of fire, gas leak, flooding, or other emergency, call 911 immediately, then notify Landlord.</li>
</ul>
</div>

<div class="addendum">
<h2>Addendum E — House Rules Enforcement</h2>
${longTermQuietHours ? `<p><strong>Noise &amp; nuisance:</strong> Quiet hours are ${longTermQuietHours}. Repeated violations may result in written notices and termination procedures as permitted by applicable law.</p>` : ""}
${longTermGuestCap ? `<p><strong>Guest violations:</strong> Gatherings beyond the ${longTermGuestCap}-guest limit require prior written approval. Repeated violations may result in written notices and termination procedures as permitted by applicable law.</p>` : ""}
<p><strong>Cleaning violations:</strong> If common areas are left unsanitary and the responsible resident does not remedy the condition after notice, Landlord may arrange cleaning at Resident's documented expense to the extent permitted by law.</p>
<p><strong>Dispute resolution:</strong> Residents are encouraged to resolve disputes between themselves first. If unresolved, bring concerns to Landlord in writing. Landlord's reasonable determination of house-rule disputes shall be final subject to applicable law.</p>
<p><strong>Three-strike policy:</strong> Three documented written warnings in any 12-month period for the same or similar violations may constitute grounds for lease termination with appropriate statutory notice.</p>
</div>
${customTermsAddendumHtml(subNorm, "Addendum F — Additional Provisions from Property Manager", propertyTemplatePreview)}
`;

  // Cross-references are resolved LAST, because a section can be referenced by text that is
  // emitted before it has claimed its number.
  const bodyWithSectionRefs = body
    .split(RENT_SECTION_TOKEN)
    .join(String(sectionRefs.rent ?? 4))
    .split(UTILITIES_SECTION_TOKEN)
    .join(String(sectionRefs.utilities ?? 8));

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Residential Room Rental Agreement — ${escapeHtml(tenantRaw)} — ${roomLabel}</title>
  <style>${leaseCss()}</style>
</head>
<body>
${bodyWithSectionRefs}
</body>
</html>`;
}
