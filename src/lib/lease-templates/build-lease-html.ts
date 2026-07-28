import { parseRoomChoiceValue } from "@/lib/rental-application/data";
import { parseFlexibleLocalDate } from "@/lib/rental-application/lease-dates";
import {
  activeCustomLeaseTerms,
  entireHomeMonthlyRentAmount,
  isEntireHomeListing,
  normalizeManagerListingSubmissionV1,
  type ManagerListingSubmissionV1,
} from "@/lib/manager-listing-submission";
import { paymentAtSigningPriceLabel, utilitiesListingEstimateLabel } from "@/lib/rental-application/listing-fees-display";
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
import { jointLeasePartiesParagraph } from "@/lib/bundle-group/joint-lease";
import { leaseCss, type LeaseJurisdictionTemplateConfig } from "@/lib/lease-templates/types";

type LeaseApplicationWithRentSnapshot = Partial<RentalWizardFormState> & {
  __signedRentLabel?: string;
};

const MONTH_TO_MONTH_RENT_SURCHARGE = 25;

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

/**
 * Manager-authored lease clauses (Lease step of the create-listing wizard),
 * rendered as an addendum. Plain text: paragraphs split on blank lines.
 */
function customTermsAddendumHtml(sub: ManagerListingSubmissionV1 | undefined, heading: string): string {
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

function sharedSpacesLeaseParagraph(raw: ManagerListingSubmissionV1 | undefined): string {
  if (!raw?.v) return "Common kitchen, bath, and living areas as shared among residents.";
  const sub = normalizeManagerListingSubmissionV1(raw);
  const entries = sub.sharedSpaces?.filter((s) => s.name.trim()) ?? [];
  if (!entries.length) return "Common kitchen, bath, and living areas as shared among residents.";
  return entries
    .map((s) => {
      const names = (s.roomAccessIds ?? [])
        .map((id) => sub.rooms.find((r) => r.id === id)?.name?.trim())
        .filter(Boolean)
        .join(", ");
      const head = names.length
        ? `${s.name.trim()} — access includes: ${names}.`
        : `${s.name.trim()}.`;
      const d = s.detail.trim();
      return d ? `${head} ${d}` : head;
    })
    .join(" ");
}

function findSubmissionRoomRent(sub: ManagerListingSubmissionV1 | undefined, unitLabel: string): string | undefined {
  if (!sub?.rooms?.length) return undefined;
  const u = unitLabel.trim().toLowerCase();
  const hit = sub.rooms.find((r) => {
    const rn = (r.name ?? "").trim().toLowerCase();
    if (!rn) return false;
    return rn.includes(u) || u.includes(rn);
  });
  if (hit && hit.monthlyRent > 0) return `$${hit.monthlyRent.toFixed(2)} / month`;
  return undefined;
}

function submissionRoomRentFromChoice(
  sub: ManagerListingSubmissionV1 | undefined,
  roomChoice1: string | undefined | null,
): string | undefined {
  if (!sub?.rooms?.length || !roomChoice1) return undefined;
  const { listingRoomId } = parseRoomChoiceValue(String(roomChoice1));
  if (!listingRoomId) return undefined;
  const normalized = normalizeManagerListingSubmissionV1(sub);
  const hit = normalized.rooms.find((r) => r.id === listingRoomId);
  if (!hit || hit.monthlyRent <= 0) return undefined;
  return `$${hit.monthlyRent.toFixed(2)} / month`;
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

function rentLabelWithMonthlySurcharge(baseLabel: string, surcharge: number): string {
  const baseAmount = parseAmount(baseLabel);
  if (baseAmount == null) return baseLabel;
  const suffixMatch = baseLabel.match(/(\/\s*month|\/\s*mo\b|monthly\b.*)$/i);
  const suffix = suffixMatch ? ` ${suffixMatch[1]!.trim()}` : "";
  return `${fmtUsd(baseAmount + surcharge)}${suffix}`;
}

function overrideFeeLabel(overrideRaw: string | undefined | null, fallbackLabel: string): string {
  const override = String(overrideRaw ?? "").trim();
  if (override) {
    const amount = parseAmount(override);
    return amount != null ? fmtUsd(amount) : override;
  }
  return fallbackLabel;
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
};

function proratedBlock(monthlyRentStr: string, utilitiesStr: string, leaseStartStr: string, prorate?: ProrateOptions): string {
  const rent = parseAmount(monthlyRentStr);
  if (!rent || !leaseStartStr || leaseStartStr === "—") return "";
  try {
    const start = parseFlexibleLocalDate(leaseStartStr);
    if (!start || isNaN(start.getTime())) return "";
    const day = start.getDate();
    if (day === 1) return "";
    const year = start.getFullYear();
    const month = start.getMonth();
    const dim = new Date(year, month + 1, 0).getDate();
    const remaining = dim - day + 1;
    const useManual = prorate?.method === "daily_rate" && prorate.dailyRentRate && prorate.dailyRentRate > 0;
    const proratedRent = useManual
      ? Math.round(prorate!.dailyRentRate! * remaining * 100) / 100
      : Math.round((rent / dim) * remaining * 100) / 100;
    const utils = parseAmount(utilitiesStr);
    const proratedUtils = useManual && prorate!.dailyUtilitiesRate && prorate!.dailyUtilitiesRate > 0
      ? Math.round(prorate!.dailyUtilitiesRate * remaining * 100) / 100
      : utils ? Math.round((utils / dim) * remaining * 100) / 100 : null;
    const total = proratedRent + (proratedUtils ?? 0);
    const rateCol = useManual ? "Daily rate" : "Monthly rate";
    const rentRateDisplay = useManual ? fmtUsd(prorate!.dailyRentRate!) + "/day" : fmtUsd(rent);
    const utilRateDisplay = useManual && prorate!.dailyUtilitiesRate && prorate!.dailyUtilitiesRate > 0
      ? fmtUsd(prorate!.dailyUtilitiesRate) + "/day"
      : utils ? fmtUsd(utils) : null;
    return `
<h2>5. Prorated First Month</h2>
<p>Because the Lease commences on the <strong>${ordinal(day)}</strong> of the month, the first partial month is prorated as follows (${remaining} of ${dim} days):</p>
<table>
  <tr><th>Item</th><th>${rateCol}</th><th>Days remaining</th><th>Prorated amount</th></tr>
  <tr><td>Rent</td><td>${rentRateDisplay}</td><td>${remaining} / ${dim}</td><td>${fmtUsd(proratedRent)}</td></tr>
  ${proratedUtils != null && utilRateDisplay != null ? `<tr><td>Utilities estimate</td><td>${utilRateDisplay}</td><td>${remaining} / ${dim}</td><td>${fmtUsd(proratedUtils)}</td></tr>` : ""}
  <tr class="total-row"><td colspan="3"><strong>Prorated total due first month</strong></td><td><strong>${fmtUsd(total)}</strong></td></tr>
</table>
<p>Beginning the first full month, regular rent and utilities as stated in Sections 4 and 9 apply.</p>
`;
  } catch {
    return "";
  }
}

/** Full HTML document suitable for download and "Print to PDF". */

export function buildLeaseHtml(ctx: LeaseGenerationContext, config: LeaseJurisdictionTemplateConfig): string {
  const { application: a, leasedRoom: room, listingProperty: list, submission: sub, generatedAtIso } = ctx;
  const signedRentLabel = (a as LeaseApplicationWithRentSnapshot).__signedRentLabel?.trim();

  // ── Identity ──────────────────────────────────────────────────────────────
  const tenantRaw = (a.fullLegalName ?? "").trim() || "Resident";
  const jointTenants =
    ctx.leaseKind === "joint_bundle" && ctx.jointLeaseMembers?.length
      ? ctx.jointLeaseMembers.map((m) => m.residentName).filter(Boolean)
      : [];
  const tenantName =
    jointTenants.length > 0 ? escapeHtml(jointTenants.join(", ")) : escapeHtml(tenantRaw);
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
  const landlordEntity = escapeHtml(sub?.buildingName?.trim() || list?.buildingName?.trim() || room?.buildingName?.trim() || "[LANDLORD ENTITY NAME]");
  const address = escapeHtml(room?.address ?? list?.address ?? sub?.address ?? "");
  const cityZip = [room?.neighborhood ?? list?.neighborhood ?? sub?.neighborhood, room?.zip ?? list?.zip ?? sub?.zip].filter(Boolean).join(", ");
  const landlordMailing = address + (cityZip ? `, ${escapeHtml(cityZip)}` : "");

  // ── Room / premises ───────────────────────────────────────────────────────
  const { listingRoomId } = parseRoomChoiceValue(String(a.roomChoice1 ?? ""));
  const subNorm = sub ? normalizeManagerListingSubmissionV1(sub) : undefined;
  const specificRoom = subNorm?.rooms.find((r) => r.id === listingRoomId) ??
    // Fallback: match by room label when listingRoomId is absent (legacy / manual assignments)
    (() => {
      const label = room?.unitLabel?.trim().toLowerCase();
      if (!label || !subNorm?.rooms.length) return undefined;
      return subNorm.rooms.find((r) => r.name.trim().toLowerCase() === label) ??
        subNorm.rooms.find((r) => r.name.trim().toLowerCase().includes(label) || label.includes(r.name.trim().toLowerCase()));
    })();

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
  const bundlePremisesLabel = leasedBundle
    ? [leasedBundle.label.trim() || "Lease bundle", bundleRoomNames.length ? bundleRoomNames.join(", ") : leasedBundle.roomsLine.trim()]
        .filter(Boolean)
        .join(" — ")
    : "";

  // Whole-home application: the premises are the entire unit (no specific room).
  const wholeHome = !leasedBundle && !specificRoom && Boolean(subNorm) && (isEntireHomeListing(subNorm!) || !subNorm!.rooms.some((r) => r.name.trim()));

  const roomLabel = escapeHtml(
    bundlePremisesLabel ||
    specificRoom?.name?.trim() ||
    (wholeHome ? "Entire home" : "") ||
    room?.unitLabel?.trim() ||
    "[ROOM NUMBER]"
  );
  const fullPremises = escapeHtml(
    [
      sub?.buildingName ?? list?.buildingName ?? room?.buildingName,
      bundlePremisesLabel || specificRoom?.name || (wholeHome ? "entire home" : room?.unitLabel),
    ]
      .filter(Boolean)
      .join(" — ") || "the Premises described herein"
  );

  // ── Rent & financials ─────────────────────────────────────────────────────
  const bundleRentLabel = leasedBundle?.price.trim() || "";
  const entireHomeRent = wholeHome && subNorm ? entireHomeMonthlyRentAmount(subNorm) : 0;
  const monthlyRentBaseStr =
    overrideFeeLabel(a.managerRentOverride, "") ||
    signedRentLabel ||
    bundleRentLabel ||
    submissionRoomRentFromChoice(sub, a.roomChoice1) ||
    (entireHomeRent > 0 ? `$${entireHomeRent.toFixed(2)} / month` : "") ||
    (room && findSubmissionRoomRent(sub, room.unitLabel)) ||
    room?.rentLabel ||
    list?.rentLabel ||
    "As set forth in the Rent Schedule";
  const monthToMonthSurcharge = isMonthToMonthLease(a) ? MONTH_TO_MONTH_RENT_SURCHARGE : 0;
  const monthlyRentStr =
    monthToMonthSurcharge > 0 ? rentLabelWithMonthlySurcharge(monthlyRentBaseStr, monthToMonthSurcharge) : monthlyRentBaseStr;

  const rentNum = parseAmount(monthlyRentStr);
  const utilitiesModel = resolveListingUtilitiesPaymentModel(sub ?? undefined, specificRoom ?? undefined);
  const utilitiesBase =
    formatUtilitiesListingLine(utilitiesModel, specificRoom?.utilitiesEstimate?.trim()) ||
    (sub ? utilitiesListingEstimateLabel(sub) : "") ||
    "—";
  const utilitiesStr = escapeHtml(overrideFeeLabel(a.managerUtilitiesOverride, utilitiesBase));
  const utilitiesNum =
    utilitiesModel === "manager_billed" && !a.managerUtilitiesOverride?.trim()
      ? parseAmount(specificRoom?.utilitiesEstimate?.trim() || utilitiesBase)
      : a.managerUtilitiesOverride?.trim()
        ? parseAmount(a.managerUtilitiesOverride)
        : utilitiesModel === "manager_billed"
          ? parseAmount(utilitiesBase)
          : 0;
  const totalMonthly =
    rentNum != null
      ? fmtUsd(rentNum + (utilitiesNum != null && utilitiesNum > 0 ? utilitiesNum : 0))
      : null;

  const appFee = escapeHtml(sub?.applicationFee ?? "—");
  const secDep = escapeHtml(overrideFeeLabel(a.managerSecurityDepositOverride, sub?.securityDeposit ?? "—"));
  const moveInFee = escapeHtml(overrideFeeLabel(a.managerMoveInFeeOverride, sub?.moveInFee ?? "—"));
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
  const billableOneTimeCustomFees = (sub?.customFees ?? []).filter((fee) => {
    const presetId = (fee as { presetId?: string }).presetId;
    if (presetId && presetId !== "custom") return false;
    if (fee.frequency !== "one-time") return false;
    const n = parseAmount(fee.amount);
    return n != null && n > 0;
  });
  const customFeesTotalNum = billableOneTimeCustomFees.reduce((s, f) => s + (parseAmount(f.amount) ?? 0), 0);
  const customFeeSigningRows = billableOneTimeCustomFees
    .map((f) => `  <tr><th>${escapeHtml(f.label?.trim() || "Custom fee")}</th><td>${escapeHtml(fmtUsd(parseAmount(f.amount) ?? 0))}</td></tr>`)
    .join("\n");
  // Monthly custom fees now bill (recurring, alongside rent), so they too must appear in the
  // lease — as Monthly line items in Exhibit A (not in the due-at-signing total).
  const billableMonthlyCustomFees = (sub?.customFees ?? []).filter((fee) => {
    const presetId = (fee as { presetId?: string }).presetId;
    if (presetId && presetId !== "custom") return false;
    if (fee.frequency === "one-time") return false;
    const n = parseAmount(fee.amount);
    return n != null && n > 0;
  });
  const customFeeExhibitRows = [...billableOneTimeCustomFees, ...billableMonthlyCustomFees]
    .map(
      (f) =>
        `  <tr><td>${escapeHtml(f.label?.trim() || "Custom fee")}</td><td>${escapeHtml(fmtUsd(parseAmount(f.amount) ?? 0))}</td><td>${
          f.frequency === "one-time" ? "One-time" : "Monthly"
        }</td></tr>`,
    )
    .join("\n");

  const paySigningBase = sub ? paymentAtSigningPriceLabel(sub) : "—";
  const paySigningNum =
    (parseAmount(secDep) ?? 0) + (parseAmount(moveInFee) ?? 0) + (otherCostNum ?? 0) + customFeesTotalNum;
  const paySigning = escapeHtml(paySigningNum > 0 ? fmtUsd(paySigningNum) : paySigningBase);

  // ── Dates ─────────────────────────────────────────────────────────────────
  const leaseTerm = dash(a.leaseTerm);
  const leaseStart = dash(a.leaseStart);
  const leaseEnd = a.leaseTerm === "Month-to-Month" ? dash(a.leaseEnd || "N/A (month-to-month)") : dash(a.leaseEnd);
  const generatedDate = escapeHtml(new Date(generatedAtIso).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" }));

  // ── Content blocks ────────────────────────────────────────────────────────
  const leaseTermsBody = escapeHtml(sub?.leaseTermsBody?.trim() || "Standard lease lengths and renewal as posted on the listing.");
  const houseOverview = escapeHtml(sub?.houseOverview?.trim() || list?.tagline || "Shared co-living housing as described on the listing.");
  const sharedSpacesText = sharedSpacesLeaseParagraph(sub);
  const leaseUtilityLines = normalizeLeaseUtilities(subNorm?.leaseUtilities);
  const utilitiesBreakdown = utilitiesResponsibilityHtml(leaseUtilityLines);
  const utilitiesEstimateSentence = !utilitiesBreakdown
    ? "This covers a prorated share of household utilities including electricity, gas, water, sewer, trash, and high-speed internet as applicable to this property."
    : hasResidentPaidLeaseUtility(leaseUtilityLines ?? [])
      ? "This estimate reflects the utilities the Resident is responsible for above."
      : "All utilities and services listed above are included in the monthly rent or paid by Landlord, up to any allowance shown.";
  const amenities = escapeHtml(sub?.amenitiesText?.trim() || "See listing amenities.");
  const houseRules = escapeHtml(sub?.houseRulesText?.trim() || "");
  const petPolicy = (room?.petFriendly ?? list?.petFriendly)
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
  const paymentMethod =
    manualPaymentMethods.length > 0
      ? `Payment may be made via Stripe (portal), ${manualPaymentMethods.join(", ")}, or another method agreed in writing.`
      : "Payment shall be made via the PropLane portal or by a method agreed in writing with Landlord.";

  const proratedSection = proratedBlock(monthlyRentStr, utilitiesStr, a.leaseStart ?? "", {
    method: specificRoom?.prorateMethod,
    dailyRentRate: specificRoom?.dailyRentRate,
    dailyUtilitiesRate: specificRoom?.dailyUtilitiesRate,
  });

  if (a.rentalType === "short_term") {
    const dailyCostRaw = subNorm?.shortTermDailyCost?.trim() || "—";
    const shortDepositRaw = subNorm?.shortTermDeposit?.trim() || "—";
    const dailyCost = parseAmount(dailyCostRaw);
    const startDate = new Date(a.leaseStart ?? "");
    const endDate = new Date(a.leaseEnd ?? "");
    const startOk = startDate && !Number.isNaN(startDate.getTime());
    const endOk = endDate && !Number.isNaN(endDate.getTime());
    const durationDays = startOk && endOk
      ? Math.max(1, Math.ceil((endDate!.getTime() - startDate!.getTime()) / (24 * 60 * 60 * 1000)) + 1)
      : null;
    const totalRent = dailyCost && durationDays ? fmtUsd(dailyCost * durationDays) : "—";
    const depositAmount = parseAmount(shortDepositRaw);
    // Short-term custom fees bill once before check-in (recordApprovedApplicationCharges), so
    // they must appear in the stay's Payment table and count toward the total due.
    const stCustomFees = (subNorm?.customFees ?? []).filter((fee) => {
      const presetId = (fee as { presetId?: string }).presetId;
      if (presetId && presetId !== "custom") return false;
      const n = parseAmount(fee.shortTermAmount);
      return n != null && n > 0;
    });
    const stCustomFeesTotal = stCustomFees.reduce((s, f) => s + (parseAmount(f.shortTermAmount) ?? 0), 0);
    const stCustomFeeRows = stCustomFees
      .map(
        (f) =>
          `  <tr><th>${escapeHtml(f.label?.trim() || "Custom fee")}</th><td>${escapeHtml(fmtUsd(parseAmount(f.shortTermAmount) ?? 0))}</td></tr>`,
      )
      .join("\n");
    const totalDue =
      dailyCost && durationDays
        ? fmtUsd(dailyCost * durationDays + (depositAmount ?? 0) + stCustomFeesTotal)
        : "—";
    const requirements = escapeHtml(
      subNorm?.shortTermRequirements?.trim() ||
        "Guest must follow all reasonable house rules provided by the Owner/Host. Guest may not receive mail, declare residency, or claim tenancy.",
    );
    const checkInTime = dash(a.shortTermCheckInTime || "10:00 PM");
    const checkOutTime = dash(a.shortTermCheckOutTime || "11:00 AM");

    return `<!doctype html><html><head><meta charset="utf-8"/><title>Short-Term Room Stay Agreement</title><style>${leaseCss()}</style></head><body>
<h1>SHORT-TERM ROOM STAY AGREEMENT</h1>
<p class="sub">${durationDays ? `${durationDays}-Day Stay` : "Temporary Room Stay"} · Generated ${generatedDate} via PropLane</p>

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
  <tr><th width="35%">Check-in date &amp; time</th><td>${leaseStart} @ ${checkInTime}</td></tr>
  <tr><th>Check-out date &amp; time</th><td>${dash(a.leaseEnd)} @ ${checkOutTime}</td></tr>
  <tr><th>Total duration</th><td>${durationDays ? `${durationDays} day${durationDays === 1 ? "" : "s"}` : "—"}</td></tr>
</table>

<h2>4. Payment</h2>
<table>
  <tr><th width="35%">Daily rent</th><td>${escapeHtml(dailyCostRaw)} per day</td></tr>
  <tr><th>Total rent for days</th><td>${totalRent}</td></tr>
  <tr><th>Security deposit</th><td>${escapeHtml(shortDepositRaw)}</td></tr>
${stCustomFeeRows}
  <tr class="total-row"><th>Total due</th><td><strong>${totalDue}</strong></td></tr>
</table>

<h2>5. Purpose of Stay</h2>
<p>${config.shortTermPurposeParagraph}</p>

<h2>6. House Rules &amp; Short-Term Requirements</h2>
<p>${requirements}</p>
${houseRules ? `<p>${houseRules}</p>` : ""}

<h2>7. No Right to Remain After Check-Out</h2>
<p>Guest must vacate the room and property by the check-out date and time. If Guest refuses to leave, Guest may be treated as a trespasser to the fullest extent permitted by law.</p>

<h2>8. Shared Residence</h2>
<p>Owner/Host lives on or controls the property. Guest is renting a room only and receives only temporary shared-area access as approved by Owner/Host.</p>

<h2>9. No Mail / No Residency</h2>
<p>Guest may not receive mail, declare residency, or claim tenancy at the property. Guest may not use the property address for government ID, voter registration, banking, employment, delivery accounts, or similar residency purposes.</p>

<h2>10. Condition of Room</h2>
<p>Guest agrees to leave the room and shared areas in clean, undamaged condition. Owner/Host may deduct unpaid amounts, cleaning costs, missing items, or damage beyond ordinary use from the deposit.</p>

<h2>11. Electronic Signature</h2>
<p>Owner/Host and Guest each sign this agreement <strong>once</strong> through the PropLane portal. The <strong>Electronic Signature Certificate</strong> at the end of the signed document is the official record of both signatures. No handwritten signature blocks appear here.</p>
${customTermsAddendumHtml(subNorm, "Additional Provisions from Owner/Host")}
</body></html>`;
  }

  const body = `
<h1>RESIDENTIAL ROOM RENTAL AGREEMENT</h1>
<p class="sub">${config.headerSubtitle}</p>
<p class="generated">Generated ${generatedDate} via PropLane</p>

<h2>1. Parties</h2>
<table>
  <tr><th width="35%">Landlord / Operator</th><td><strong>${landlordEntity}</strong><br/>Mailing address: ${landlordMailing}<br/>For notices, use PropLane portal messaging or the address above.</td></tr>
  <tr><th>Resident / Tenant</th><td><strong>${tenantName}</strong><br/>Phone: ${tenantPhone} &nbsp;·&nbsp; Email: ${tenantEmail}<br/>Date of birth: ${tenantDob}</td></tr>
</table>
${jointPartiesNote ? `<p>${jointPartiesNote}</p>` : ""}

<h2>2. Premises</h2>
<p>Landlord leases to Resident the following private room and appurtenant shared-area rights:</p>
<table>
  <tr><th width="35%">Property / building</th><td>${landlordEntity}</td></tr>
  <tr><th>Street address</th><td>${address}</td></tr>
  <tr><th>City / ZIP</th><td>${escapeHtml(cityZip)}</td></tr>
  <tr><th>Room / unit</th><td><strong>${roomLabel}</strong></td></tr>
  <tr><th>Full description</th><td>${fullPremises}</td></tr>
</table>
<p>${houseOverview}</p>
${config.municipalComplianceParagraph ? `<p>${escapeHtml(config.municipalComplianceParagraph)}</p>` : ""}

<h2>3. Lease Term</h2>
<p>The initial term is <strong>${leaseTerm}</strong>, beginning <strong>${leaseStart}</strong> and ending <strong>${leaseEnd}</strong>. ${leaseTermsBody}</p>
<p>At the conclusion of the initial term, the tenancy shall convert to a month-to-month tenancy under the same terms unless either party provides written notice to terminate at least 20 days before the end of any monthly rental period.</p>

<h2>4. Rent</h2>
<table>
  <tr><th width="50%">Monthly base rent</th><td><strong>${escapeHtml(monthlyRentBaseStr)}</strong></td></tr>
  ${monthToMonthSurcharge > 0 ? `<tr><th>Month-to-month surcharge</th><td><strong>+${fmtUsd(monthToMonthSurcharge)} / month (non-refundable)</strong></td></tr>` : ""}
  <tr><th>Utilities / services (monthly estimate)</th><td><strong>${utilitiesStr}</strong></td></tr>
  ${totalMonthly ? `<tr class="total-row"><th>Total monthly payment</th><td><strong>${totalMonthly}</strong></td></tr>` : ""}
</table>
<p>Rent is due on the <strong>1st calendar day</strong> of each month. ${paymentMethod}</p>
<p><strong>Late fee:</strong> If rent is not received by the <strong>5th of the month</strong>, a late fee of $50.00 shall be assessed and is immediately due. Additional late fees of $10.00 per day may accrue after the 10th of the month, not to exceed amounts permitted under ${config.lateFeeStatuteRef}.</p>

${proratedSection || ""}

<h2>${proratedSection ? "6" : "5"}. Security Deposit &amp; Move-In Charges</h2>
<table>
  <tr><th width="50%">Application fee</th><td>${appFee}</td></tr>
  <tr><th>Security deposit</th><td><strong>${secDep}</strong></td></tr>
  <tr><th>Move-in fee (non-refundable)</th><td>${moveInFee}</td></tr>
  ${showOtherSigningCost ? `<tr><th>${otherCostLabel}</th><td>${otherCostAmount}</td></tr>` : ""}
${customFeeSigningRows}
  <tr><th>Total due at signing</th><td><strong>${paySigning}</strong></td></tr>
</table>
<p>Resident shall pay a security deposit of <strong>${secDep}</strong> at lease signing. The deposit shall be held in accordance with ${config.depositStatuteRef} and secures Resident&apos;s full performance under this Agreement. Resident&apos;s liability is not limited to the deposit amount, and the deposit may not be applied toward rent or other charges during the tenancy.</p>
<p>Within 30 days after termination of the tenancy and vacancy of the Premises, Landlord shall return any refundable portion of the deposit or provide a written itemized statement of deductions, as required by law. Resident shall provide a forwarding address for delivery of the deposit accounting and any refund. Any refund may be issued as a single check payable to all Residents.</p>
<p>Deductions from the deposit may include, to the extent permitted by law:</p>
<ul>
  <li>Unpaid rent, utilities, or other charges.</li>
  <li>Cleaning and restoration beyond ordinary wear and tear.</li>
  <li>Repair or replacement of missing or damaged property, fixtures, or keys.</li>
  <li>Fees or charges due under this Agreement (including early termination).</li>
  <li>Reasonable labor costs (Landlord at $60/hour or third-party actual cost).</li>
</ul>
<p>Landlord shall be deemed in compliance if the statement and any refund are mailed with First Class postage within the required timeframe. A $50 stop-payment/reissuance fee may be deducted if a refund must be reissued due to an incorrect or missing address, where permitted by law.</p>

<h2>${proratedSection ? "7" : "6"}. Returned Payments</h2>
<p>If any payment is returned for insufficient funds or any other reason, Resident shall pay a returned-payment fee of $35.00 in addition to any applicable bank charges. After two returned payments, Landlord may require all future payments to be made by cashier's check, money order, or Zelle.</p>

<h2>${proratedSection ? "8" : "7"}. Utilities &amp; Services</h2>
${utilitiesBreakdown}
<p>The estimated monthly utilities / RUBS charge is <strong>${utilitiesStr}</strong>. ${utilitiesEstimateSentence} The actual charge may vary based on usage. Resident shall not engage in unusual or wasteful energy use. Landlord reserves the right to bill excess usage directly to Resident with 30 days' advance written notice of a change in the utility structure.</p>

<h2>${proratedSection ? "9" : "8"}. Use, Occupancy &amp; Guest Policy</h2>
<p>The Premises shall be used exclusively as a private residence. The only authorized occupant(s) are: <strong>${tenantName}</strong> and <strong>${occupancy}</strong> additional authorized occupant(s) listed in writing at signing.</p>
<ul>
  <li><strong>Guests:</strong> No guest is permitted on the property or in the room unless Landlord gives prior written approval in advance.</li>
  <li><strong>No short-term rentals:</strong> Listing the room on Airbnb, VRBO, or any similar platform is strictly prohibited and constitutes grounds for immediate termination.</li>
  <li><strong>Business use:</strong> No commercial, business, or professional activity that generates client visits or deliveries is permitted.</li>
  <li><strong>Illegal activity:</strong> No illegal activity of any kind on or near the Premises.</li>
</ul>

<h2>${proratedSection ? "10" : "9"}. Shared Spaces</h2>
<p>${escapeHtml(sharedSpacesText)}</p>
<p><strong>Building amenities (summary):</strong> ${amenities}</p>

<h2>${proratedSection ? "11" : "10"}. House Rules</h2>
${houseRules
  ? `<p>${houseRules}</p>`
  : `<ul>
  <li><strong>Quiet hours:</strong> 10:00 PM – 8:00 AM daily. No loud music, TV, or gatherings that disturb other residents during these hours.</li>
  <li><strong>Kitchen &amp; dining:</strong> Clean dishes, pots, and counters after each use within 24 hours. Label personal food. No leaving dirty dishes overnight.</li>
  <li><strong>Bathroom:</strong> Keep assigned bathroom clean. Wipe surfaces after use. Remove personal items from shared spaces.</li>
  <li><strong>Trash:</strong> Bag all trash and place in designated containers. Follow the posted schedule for curbside collection.</li>
  <li><strong>Common areas:</strong> Vacuum / mop per posted schedule. Do not leave personal belongings in common areas for more than 24 hours.</li>
  <li><strong>Smoking:</strong> Smoking, vaping, and cannabis use are prohibited inside the property and within 25 feet of any door or window.</li>
  <li><strong>Noise &amp; conflict:</strong> Disputes between residents should be addressed respectfully. Persistent nuisance behavior is grounds for lease termination.</li>
</ul>`}

<h2>${proratedSection ? "12" : "11"}. Pets</h2>
<p>${escapeHtml(petPolicy)}</p>
<p>Pet disclosure on application: <strong>${pets}</strong>.</p>

<h2>${proratedSection ? "13" : "12"}. Maintenance &amp; Repairs</h2>
<h3>Landlord responsibilities (RCW 59.18.060):</h3>
<ul>
  <li>Maintain the dwelling in a structurally sound, weathertight, and sanitary condition.</li>
  <li>Provide adequate heating capable of maintaining 68°F and functioning plumbing and hot water.</li>
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
<h3>Alterations:</h3>
<p>Resident shall not paint, drill, install fixtures, or make any alterations without prior written approval. Unauthorized alterations must be restored at Resident's expense at move-out.</p>

<h2>${proratedSection ? "14" : "13"}. Landlord Entry (${config.landlordEntryStatuteRef})</h2>
<p>Landlord or Landlord's authorized agents may enter the Premises after providing at least <strong>24 hours' advance written notice</strong> (email to Resident's address of record shall suffice) for the purpose of inspections, repairs, improvements, or showing to prospective tenants or buyers. Entry shall be at reasonable times unless agreed otherwise.</p>
<p>In case of <strong>emergency</strong> (fire, flood, gas leak, or other imminent hazard), Landlord may enter without notice. After an emergency entry, Landlord shall provide written notice to Resident as soon as reasonably practicable.</p>

<h2>${proratedSection ? "15" : "14"}. Assignment &amp; Subletting</h2>
<p>Resident may not assign this lease, sublet the room, or accommodate any occupant not authorized in Section ${proratedSection ? "9" : "8"} without prior written consent of Landlord. Consent shall not be unreasonably withheld where Resident provides a qualified replacement tenant. Any unauthorized subletting, including short-term rentals, constitutes material breach.</p>

<h2>${proratedSection ? "16" : "15"}. Renter's Insurance</h2>
<p>Resident is <strong>strongly encouraged</strong> to maintain renter's insurance with at least $100,000 in personal liability coverage. Landlord's property insurance does <em>not</em> cover Resident's personal belongings or liability. Landlord is not liable for theft, fire, water damage, or loss of Resident's personal property.</p>

<h2>${proratedSection ? "17" : "16"}. Default &amp; Remedies</h2>
<p>A material breach includes but is not limited to: nonpayment of rent or fees, unauthorized occupants, violation of house rules, illegal activity, or substantial damage to the Premises. Upon material breach:</p>
<ul>
  <li>Landlord shall provide written notice to cure or vacate per ${config.defaultNoticeStatuteRef} (3-day pay-or-vacate for nonpayment; 10-day cure notice for other violations).</li>
  <li>If uncured, Landlord may pursue eviction (unlawful detainer), monetary damages, and attorneys' fees.</li>
  <li>Resident remains liable for rent through the end of the lease term or until a qualified replacement tenant begins paying rent, whichever occurs first.</li>
</ul>

<h2>${proratedSection ? "18" : "17"}. Early Termination</h2>
<p>If Resident terminates the lease prior to the end of the initial term, Resident shall provide at least <strong>30 days' written notice</strong> and pay an early-termination fee equal to <strong>1.5 months' rent</strong>, plus any costs Landlord incurs to re-rent the room (advertising, cleaning, repairs). Resident remains responsible for rent until a qualified replacement tenant begins paying. The early-termination fee does not apply if early termination is required by military orders (SCRA) or another applicable legal exemption.</p>

<h2>${proratedSection ? "19" : "18"}. Payment Application Order</h2>
<p>Any payments received shall be applied in the following order: (1) outstanding damage charges; (2) outstanding utility charges; (3) late fees and administrative fees; (4) past due rent (oldest first); (5) current rent.</p>

<h2>${proratedSection ? "20" : "19"}. Notices</h2>
<p>All notices shall be in writing. Delivery by email to the address on file or via PropLane portal messaging is acceptable and shall be deemed received upon sending during business hours. Legal notices may also be delivered in person or by first-class mail to the mailing addresses listed in Section 1. Either party may update their notice address in writing.</p>

<h2>${proratedSection ? "21" : "20"}. Lead-Based Paint Disclosure</h2>
<p>If the property was built before 1978, federal law (42 U.S.C. § 4852d) requires disclosure of known lead-based paint hazards. Resident acknowledges receiving the EPA pamphlet "Protect Your Family From Lead in Your Home" or waiving receipt in writing. Landlord discloses any known lead hazards in the separate disclosure addendum attached hereto (or: no known lead paint hazards).</p>

<h2>${proratedSection ? "22" : "21"}. Governing Law; Severability; Entire Agreement</h2>
<p>${config.governingLawParagraph}</p>

<h2>${proratedSection ? "23" : "22"}. Attorney Fees</h2>
<p>In any action to enforce or interpret this Agreement, the prevailing party shall be entitled to recover reasonable attorney fees and court costs as permitted by law.</p>

<h2>${proratedSection ? "24" : "23"}. Application Summary (Incorporated by Reference)</h2>
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

<h2>${proratedSection ? "25" : "24"}. Rent &amp; Fees Schedule (Exhibit A)</h2>
<table>
  <tr><th>Item</th><th>Amount</th><th>Frequency</th></tr>
  <tr><td>Monthly base rent</td><td><strong>${escapeHtml(typeof monthlyRentStr === "string" ? monthlyRentStr : String(monthlyRentStr))}</strong></td><td>Monthly, due 1st</td></tr>
  <tr><td>Utilities / services estimate</td><td>${utilitiesStr}</td><td>Monthly</td></tr>
  ${totalMonthly ? `<tr class="total-row"><td><strong>Total monthly payment</strong></td><td><strong>${totalMonthly}</strong></td><td>Monthly</td></tr>` : ""}
  <tr><td>Application fee</td><td>${appFee}</td><td>One-time</td></tr>
  <tr><td>Security deposit</td><td>${secDep}</td><td>One-time (refundable)</td></tr>
  <tr><td>Move-in fee</td><td>${moveInFee}</td><td>One-time (non-refundable)</td></tr>
  ${showOtherSigningCost ? `<tr><td>${otherCostLabel}</td><td>${otherCostAmount}</td><td>One-time</td></tr>` : ""}
${customFeeExhibitRows}
  <tr><td>Total due at signing</td><td>${paySigning}</td><td>At signing</td></tr>
</table>

<h2>${proratedSection ? "26" : "25"}. Electronic Signature</h2>
<p><strong>Landlord / Authorized Agent</strong> and <strong>Resident / Tenant</strong> each execute this Agreement <strong>one time</strong> through the PropLane portal (one manager signature and one resident signature). The <strong>Electronic Signature Certificate</strong> appended to the signed copy is the binding record for both parties. No duplicate handwritten signature lines are included in this document.</p>

<!-- ═══════════════════════════════════════════════════════════════════════ -->
<div class="addendum page-break">
<h2>Addendum A — Move-In Condition Report</h2>
<p>Resident and Landlord agree to complete and sign this report within <strong>5 days of move-in</strong>. Resident may document any pre-existing damage and return it to Landlord by email. Absent a completed report, the room shall be deemed to be in clean, undamaged condition at move-in.</p>
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
</div>

<div class="addendum">
<h2>Addendum B — Bed Bug Disclosure</h2>
<p>Landlord discloses that, to Landlord's knowledge as of the date of this Agreement, there is <strong>no known active bed bug infestation</strong> in the unit or building. Resident shall inspect the room upon move-in and report any signs of bed bugs immediately. If an infestation is discovered during the tenancy, Resident shall notify Landlord in writing within 24 hours and cooperate with any required inspection or treatment. Resident shall not introduce second-hand mattresses, upholstered furniture, or bedding without prior written approval. Resident is responsible for infestation caused by Resident's belongings or guests.</p>
</div>

<div class="addendum">
<h2>Addendum C — Mold &amp; Moisture Policy</h2>
<p>Resident agrees to maintain adequate ventilation in the room and bathroom (open windows when possible, use exhaust fans). Resident shall promptly report visible mold, moisture intrusion, or condensation to Landlord in writing. Resident shall wipe down surfaces subject to moisture (shower walls, windowsills) regularly. Resident shall not dry laundry inside the room or any space without adequate ventilation. Failure to report mold or moisture conditions within 24 hours of discovery may result in Resident being held liable for resulting damage (RCW 59.18.130).</p>
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
<p><strong>Noise &amp; nuisance:</strong> Quiet hours are strictly enforced (10 PM – 8 AM). Violations will result in a written warning for the first offense, a $50 fine for the second offense, and potential termination proceedings for subsequent violations.</p>
<p><strong>Guest violations:</strong> Unauthorized overnight guests beyond policy limits will result in a written warning. Repeated violations are grounds for a 10-day cure notice.</p>
<p><strong>Cleaning violations:</strong> If common areas are left unsanitary and the responsible resident does not remedy within 24 hours of notice, Landlord may arrange cleaning at Resident's expense ($50 minimum).</p>
<p><strong>Dispute resolution:</strong> Residents are encouraged to resolve disputes between themselves first. If unresolved, bring concerns to Landlord in writing. Landlord's reasonable determination of house-rule disputes shall be final subject to applicable law.</p>
<p><strong>Three-strike policy:</strong> Three documented written warnings in any 12-month period for the same or similar violations may constitute grounds for lease termination with appropriate statutory notice.</p>
</div>
${customTermsAddendumHtml(subNorm, "Addendum F — Additional Provisions from Property Manager")}
`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Residential Room Rental Agreement — ${escapeHtml(tenantRaw)} — ${roomLabel}</title>
  <style>${leaseCss()}</style>
</head>
<body>
${body}
</body>
</html>`;
}

