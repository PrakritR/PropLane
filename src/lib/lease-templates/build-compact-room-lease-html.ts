import type { LeaseUtilityLine } from "@/lib/lease-utilities";
import { leaseUtilityKindLabel } from "@/lib/lease-utilities";
import type { ManagerListingSubmissionV1 } from "@/lib/manager-listing-submission";
import type { LeaseJurisdictionTemplateConfig } from "@/lib/lease-templates/types";
import { paymentAtSigningIncludedLabels } from "@/lib/rental-application/listing-fees-display";

export type CompactRoomLeaseInput = {
  config: LeaseJurisdictionTemplateConfig;
  tenantRaw: string;
  tenantName: string;
  landlordEntity: string;
  roomLabel: string;
  address: string;
  cityZip: string;
  leaseStart: string;
  leaseEnd: string;
  leaseTerm: string;
  monthlyRentDisplay: string;
  utilitiesDisplay: string;
  secDep: string;
  moveInFee: string;
  paySigning: string;
  paySigningNum: number;
  firstPartialMonthPayment: number;
  proratedRentAmount?: number;
  proratedUtilitiesAmount?: number;
  billableOneTimeCustomFees: ReadonlyArray<{ label?: string; amount?: string }>;
  billableMonthlyCustomFees: ReadonlyArray<{ label?: string; amount?: string }>;
  /** Preset one-time fees (application, holding deposit, etc.) not due at signing. */
  supplementalOneTimeLeaseFees?: ReadonlyArray<{ label?: string; amount?: string }>;
  paymentAtSigningIncludes?: readonly string[];
  paymentMethod: string;
  sub: ManagerListingSubmissionV1 | undefined;
  specificRoom: { floor?: string; name?: string } | undefined;
  bathroomArrangement: string;
  leaseUtilityLines: readonly LeaseUtilityLine[] | undefined;
  houseRules: string;
  longTermBreakLeaseFee: number | null;
  longTermLeaseUpFeePercent: number | null;
  longTermHoldoverDailyRate: number | null;
  longTermQuietHours: string;
  hasConfiguredHoldover: boolean;
  hasConfiguredEarlyTerminationTerm: boolean;
  earlyTerminationStatuteRef?: string;
  governingLawLabel: string;
  depositStatuteRef: string;
  residentMaintenanceStatuteRef: string;
  propertyTemplatePreview: boolean;
  listingFeePreview?: boolean;
  generatedDate: string;
  disclosureReviewNotice: string;
  customTermsAddendumHtml: string;
  leadDisclosureHtml?: string;
  utilitiesBreakdown?: string;
  utilitiesEstimateSentence?: string;
  tenantPhone?: string;
  tenantEmail?: string;
  tenantDob?: string;
  fmtUsd: (n: number) => string;
  parseAmount: (s: string | undefined | null) => number | null;
  escapeHtml: (s: string) => string;
  isMonthToMonthLease: boolean;
};

function compactPremisesAccessParagraph(
  room: { floor?: string } | undefined,
  bathroomArrangement: string,
  escapeHtml: (s: string) => string,
): string {
  const floor = room?.floor?.trim();
  const floorClause = floor
    ? `exclusive use of their room on ${escapeHtml(floor)} floor`
    : "exclusive use of their private room";
  let bathroomClause = "shared use of bathroom facilities on the property";
  const bath = bathroomArrangement.trim();
  if (bath.includes("assigned to this room")) {
    bathroomClause = "use only the bathroom assigned to their room";
  } else if (bath.includes("shared with") || bath.includes("shared by")) {
    bathroomClause = "use only bathroom on their floor";
  }
  return `Resident shall have ${floorClause}, ${bathroomClause}, and shared, non-exclusive use of the kitchen, living areas, laundry facilities, hallways, and other designated common areas together with other residents.`;
}

function compactPaymentInstruction(
  sub: ManagerListingSubmissionV1 | undefined,
  paymentMethod: string,
  escapeHtml: (s: string) => string,
): string {
  if (sub?.zellePaymentsEnabled && sub.zelleContact?.trim()) {
    return `Payments shall be made by Zelle to <strong>${escapeHtml(sub.zelleContact.trim())}</strong>.`;
  }
  if (sub?.venmoPaymentsEnabled && sub.venmoContact?.trim() && !sub?.zellePaymentsEnabled) {
    return `Payments shall be made by Venmo to <strong>${escapeHtml(sub.venmoContact.trim())}</strong>.`;
  }
  return `Payments shall be made ${paymentMethod.replace(/^Payment (may be|shall be) made (via|by) /i, "by ").replace(/\.$/, "")}.`;
}

function utilitiesIncludedBullets(
  lines: readonly LeaseUtilityLine[] | undefined,
  escapeHtml: (s: string) => string,
): string {
  if (lines?.length) {
    const items = lines
      .filter((line) => line.paidBy !== "resident")
      .map((line) => `<li>${escapeHtml(leaseUtilityKindLabel(line))}</li>`)
      .filter(Boolean);
    if (items.length) {
      return `<ul>${items.join("")}</ul>`;
    }
  }
  return `<ul>
  <li>Electricity</li>
  <li>Water</li>
  <li>Sewer</li>
  <li>Garbage</li>
  <li>Wi-Fi Internet</li>
</ul>`;
}

function moveInPaymentSummaryHtml(input: CompactRoomLeaseInput): string {
  const {
    fmtUsd,
    parseAmount,
    escapeHtml,
    secDep,
    moveInFee,
    paySigningNum,
    firstPartialMonthPayment,
    proratedRentAmount = 0,
    proratedUtilitiesAmount = 0,
    billableOneTimeCustomFees,
    billableMonthlyCustomFees,
    supplementalOneTimeLeaseFees,
    paySigning,
    paymentAtSigningIncludes,
  } = input;
  if (input.propertyTemplatePreview && !input.listingFeePreview) {
    return "<p>Move-in payment details are filled when a resident is placed at this property.</p>";
  }
  const includes = new Set(paymentAtSigningIncludes ?? []);
  const useIncludesFilter = includes.size > 0;
  const scheduleLines: string[] = [];
  const signingLines: string[] = [];

  const pushSchedule = (line: string) => {
    scheduleLines.push(line);
  };
  const pushSigning = (line: string) => {
    signingLines.push(line);
  };

  if (proratedRentAmount > 0) {
    pushSchedule(`Prorated first month&apos;s rent: <strong>${fmtUsd(proratedRentAmount)}</strong>`);
    if (!useIncludesFilter || includes.has("first_month_rent")) {
      pushSigning(`<strong>${fmtUsd(proratedRentAmount)}</strong> prorated first month&apos;s rent`);
    }
  }
  if (proratedUtilitiesAmount > 0) {
    pushSchedule(`Prorated utilities: <strong>${fmtUsd(proratedUtilitiesAmount)}</strong>`);
    if (!useIncludesFilter || includes.has("first_month_utilities")) {
      pushSigning(`<strong>${fmtUsd(proratedUtilitiesAmount)}</strong> prorated utilities`);
    }
  }
  if (
    firstPartialMonthPayment > 0 &&
    proratedRentAmount <= 0 &&
    proratedUtilitiesAmount <= 0
  ) {
    pushSchedule(`Prorated first month (rent and utilities): <strong>${fmtUsd(firstPartialMonthPayment)}</strong>`);
    if (
      !useIncludesFilter ||
      includes.has("first_month_rent") ||
      includes.has("first_month_utilities")
    ) {
      pushSigning(`<strong>${fmtUsd(firstPartialMonthPayment)}</strong> for the first partial month (prorated rent and utilities)`);
    }
  }

  const secDepNum = parseAmount(secDep);
  if (secDepNum != null && secDepNum > 0) {
    pushSchedule(`Security deposit: <strong>${secDep}</strong>`);
    if (!useIncludesFilter || includes.has("security_deposit")) {
      pushSigning(`<strong>${secDep}</strong> security deposit`);
    }
  }
  const moveInNum = parseAmount(moveInFee);
  if (moveInNum != null && moveInNum > 0) {
    pushSchedule(`Move-in fee (non-refundable): <strong>${moveInFee}</strong>`);
    if (!useIncludesFilter || includes.has("move_in_fee")) {
      pushSigning(`<strong>${moveInFee}</strong> move-in fee (non-refundable)`);
    }
  }
  for (const fee of billableOneTimeCustomFees) {
    const amount = parseAmount(fee.amount);
    if (amount != null && amount > 0) {
      const label = escapeHtml(fee.label?.trim() || "custom fee");
      pushSchedule(`${label}: <strong>${fmtUsd(amount)}</strong>`);
      pushSigning(`<strong>${fmtUsd(amount)}</strong> ${label}`);
    }
  }

  if (!scheduleLines.length && paySigningNum <= 0) {
    return "<p>No move-in charges are due beyond recurring monthly rent and utilities.</p>";
  }
  const schedule =
    scheduleLines.length > 0
      ? `<p style="margin:0 0 0.35rem;font-weight:700">Payment schedule</p><ul>${scheduleLines.map((line) => `<li>${line}</li>`).join("")}</ul>`
      : "";
  const signingDetail =
    signingLines.length > 0
      ? `<p style="margin:0.75rem 0 0.35rem;font-weight:700">Due at signing</p><ul>${signingLines.map((line) => `<li>${line}</li>`).join("")}</ul>`
      : "";
  const total =
    paySigningNum > 0
      ? `<p style="margin:0.75rem 0 0">Total payment due at signing: <strong>${paySigning}</strong></p>`
      : "";
  return `${schedule}${signingDetail}${total}`;
}

function defaultHouseRulesBullets(): string {
  return `<ul>
  <li>Keep the room clean and sanitary.</li>
  <li>Use only the bathroom on your floor.</li>
  <li>Clean shared spaces after use.</li>
  <li>Respect the privacy of other residents.</li>
  <li>Maintain reasonable noise levels.</li>
  <li>Follow posted house rules.</li>
  <li>Properly dispose of trash.</li>
  <li>Report maintenance issues promptly.</li>
</ul>
<p>No smoking, vaping, illegal drugs, or unauthorized pets are permitted inside the property.</p>`;
}

function earlyTerminationBlock(input: CompactRoomLeaseInput): string {
  const { fmtUsd, hasConfiguredEarlyTerminationTerm, longTermBreakLeaseFee, longTermLeaseUpFeePercent, earlyTerminationStatuteRef, governingLawLabel } =
    input;
  if (!hasConfiguredEarlyTerminationTerm) {
    return "<p>Any early termination is governed by applicable law and a written agreement between the parties.</p>";
  }
  const statute = earlyTerminationStatuteRef ? `, in accordance with ${earlyTerminationStatuteRef}` : "";
  return `<p>If Resident vacates prior to lease expiration or without proper notice, Resident shall be liable for:</p>
<ul>
  ${longTermBreakLeaseFee != null && longTermBreakLeaseFee > 0 ? `<li>A break lease fee of <strong>${fmtUsd(longTermBreakLeaseFee)}</strong></li>` : ""}
  ${longTermLeaseUpFeePercent != null ? `<li>A prorated lease-up fee of up to <strong>${longTermLeaseUpFeePercent}% of one month&apos;s rent</strong></li>` : ""}
  <li>Ongoing rent, utilities, and recurring charges until a replacement resident takes possession or the lease term ends (whichever occurs first)${statute}</li>
  <li>Any difference between the replacement rent and the rent under this Agreement</li>
  <li>All actual re-renting costs, including court costs and reasonable attorneys&apos; fees</li>
</ul>
<p>If Resident breaks the lease without Landlord&apos;s written consent, Resident shall also be liable for actual damages and unpaid obligations permitted by ${governingLawLabel}, including unpaid rent through the earlier of the lease end date or the date a replacement resident takes possession.</p>`;
}

export function buildCompactRoomLeaseBody(input: CompactRoomLeaseInput): string {
  const {
    tenantName,
    landlordEntity,
    roomLabel,
    address,
    cityZip,
    leaseStart,
    leaseEnd,
    monthlyRentDisplay,
    utilitiesDisplay,
    secDep,
    moveInFee,
    paySigning,
    firstPartialMonthPayment,
    houseRules,
    longTermHoldoverDailyRate,
    hasConfiguredHoldover,
    longTermQuietHours,
    config,
    generatedDate,
    disclosureReviewNotice,
    customTermsAddendumHtml,
    isMonthToMonthLease,
    fmtUsd,
    escapeHtml,
    sub,
    specificRoom,
    bathroomArrangement,
    leaseUtilityLines,
    paymentMethod,
    propertyTemplatePreview,
    depositStatuteRef,
    residentMaintenanceStatuteRef,
  } = input;

  const premisesLine = `${roomLabel}, ${address}${cityZip ? `, ${escapeHtml(cityZip)}` : ""}`;
  const leaseTermLine = `${leaseStart} through ${leaseEnd}`;
  const premisesAccess = compactPremisesAccessParagraph(specificRoom, bathroomArrangement, escapeHtml);
  const paymentInstruction = compactPaymentInstruction(sub, paymentMethod, escapeHtml);
  const utilitiesBullets = utilitiesIncludedBullets(leaseUtilityLines, escapeHtml);
  const houseRulesBlock = houseRules
    ? `<p>${houseRules}</p><p>No smoking, vaping, illegal drugs, or unauthorized pets are permitted inside the property.</p>`
    : defaultHouseRulesBullets();
  const quietHours = longTermQuietHours || "10 PM – 8 AM";
  const disputeVenue = sub?.longTermDisputeVenue?.trim() || "King County, Washington";
  const monthlyCustomFeeLines = input.billableMonthlyCustomFees
    .map((fee) => {
      const amount = input.parseAmount(fee.amount);
      if (amount == null || amount <= 0) return "";
      return `<p><strong>${escapeHtml(fee.label?.trim() || "Custom fee")}:</strong> ${fmtUsd(amount)} (monthly)</p>`;
    })
    .filter(Boolean)
    .join("\n");
  const supplementalOneTimeFeeLines = (input.supplementalOneTimeLeaseFees ?? [])
    .map((fee) => {
      const amount = input.parseAmount(fee.amount);
      if (amount == null || amount <= 0) return "";
      return `<p><strong>${escapeHtml(fee.label?.trim() || "Fee")}:</strong> ${fmtUsd(amount)} (one-time)</p>`;
    })
    .filter(Boolean)
    .join("\n");
  const showProratedFirstMonth = input.firstPartialMonthPayment > 0;
  const prorationLine = showProratedFirstMonth
    ? input.proratedRentAmount != null &&
      input.proratedRentAmount > 0 &&
      input.proratedUtilitiesAmount != null &&
      input.proratedUtilitiesAmount > 0
      ? `<p>For the first partial month, Resident shall pay <strong>${fmtUsd(input.proratedRentAmount)}</strong> prorated rent and <strong>${fmtUsd(input.proratedUtilitiesAmount)}</strong> prorated utilities (total <strong>${fmtUsd(input.firstPartialMonthPayment)}</strong>).</p>`
      : `<p>For the first partial month, Resident shall pay <strong>${fmtUsd(input.firstPartialMonthPayment)}</strong> (prorated rent and utilities).</p>`
    : "";

  const rentNum = input.parseAmount(monthlyRentDisplay);
  const utilNum = input.parseAmount(utilitiesDisplay);
  const isDailyRentDisplay = /\/\s*day/i.test(monthlyRentDisplay);
  const totalMonthlyDisplay =
    !isDailyRentDisplay && rentNum != null && utilNum != null && rentNum > 0 && utilNum > 0
      ? fmtUsd(rentNum + utilNum)
      : null;

  const monthlyCustomFeeSummaryLines = input.billableMonthlyCustomFees
    .map((fee) => {
      const amount = input.parseAmount(fee.amount);
      if (amount == null || amount <= 0) return "";
      return `<p style="margin:0.2rem 0"><strong>${escapeHtml(fee.label?.trim() || "Custom fee")}:</strong> ${fmtUsd(amount)}/mo</p>`;
    })
    .filter(Boolean)
    .join("\n");

  const supplementalOneTimeSummaryLines = (input.supplementalOneTimeLeaseFees ?? [])
    .map((fee) => {
      const amount = input.parseAmount(fee.amount);
      if (amount == null || amount <= 0) return "";
      return `<p style="margin:0.2rem 0"><strong>${escapeHtml(fee.label?.trim() || "Fee")}:</strong> ${fmtUsd(amount)}</p>`;
    })
    .filter(Boolean)
    .join("\n");

  const oneTimeCustomFeeSummaryLines = input.billableOneTimeCustomFees
    .map((fee) => {
      const amount = input.parseAmount(fee.amount);
      if (amount == null || amount <= 0) return "";
      return `<p style="margin:0.2rem 0"><strong>${escapeHtml(fee.label?.trim() || "Custom fee")}:</strong> ${fmtUsd(amount)}</p>`;
    })
    .filter(Boolean)
    .join("\n");

  const paySigningIncludesNote = input.sub ? escapeHtml(paymentAtSigningIncludedLabels(input.sub)) : "";

  const leaseSummaryHtml = `<div style="border:1px solid #999;padding:12px 14px;margin:0 0 1.25rem;background:#fafafa">
  <p style="margin:0 0 0.5rem;font-weight:700;text-align:center;text-transform:uppercase;letter-spacing:.04em">Lease Summary</p>
  <p style="margin:0.2rem 0"><strong>Landlord:</strong> ${landlordEntity}</p>
  <p style="margin:0.2rem 0"><strong>Resident:</strong> ${tenantName}</p>
  <p style="margin:0.2rem 0"><strong>Premises:</strong> ${premisesLine}</p>
  <p style="margin:0.2rem 0"><strong>Lease Term:</strong> ${leaseTermLine}</p>
  <p style="margin:0.2rem 0"><strong>Monthly Rent:</strong> ${monthlyRentDisplay}</p>
  <p style="margin:0.2rem 0"><strong>Utility:</strong> ${utilitiesDisplay}</p>
  ${totalMonthlyDisplay ? `<p style="margin:0.2rem 0"><strong>Total monthly payment:</strong> ${totalMonthlyDisplay}</p>` : ""}
  ${showProratedFirstMonth ? `<p style="margin:0.2rem 0"><strong>Prorated first month:</strong> ${fmtUsd(firstPartialMonthPayment)}</p>` : input.listingFeePreview ? `<p style="margin:0.2rem 0"><strong>Prorated first month:</strong> Calculated from the lease start date when it is not the 1st of the month</p>` : ""}
  <p style="margin:0.2rem 0"><strong>Security Deposit:</strong> ${secDep}</p>
  <p style="margin:0.2rem 0"><strong>Move-in Fee:</strong> ${moveInFee}</p>
  ${monthlyCustomFeeSummaryLines}
  ${supplementalOneTimeSummaryLines}
  ${oneTimeCustomFeeSummaryLines}
  <p style="margin:0.2rem 0"><strong>Payment Due at Signing:</strong> ${paySigning}</p>
  ${paySigningIncludesNote ? `<p style="margin:0.35rem 0 0;font-size:0.92em">Due at signing includes: ${paySigningIncludesNote}.</p>` : ""}
</div>`;

  const holdoverClause =
    hasConfiguredHoldover && longTermHoldoverDailyRate != null && longTermHoldoverDailyRate > 0
      ? ` Any continued occupancy after termination shall be charged <strong>${fmtUsd(longTermHoldoverDailyRate)} per day</strong>.`
      : "";

  const monthToMonthNotice =
    input.config.monthToMonthTerminationNotice ?? "within the period required by applicable law";
  const leaseTermSection = isMonthToMonthLease
    ? `<p>This tenancy is month-to-month beginning <strong>${leaseStart}</strong> and continuing until lawfully ended. Either party may provide written notice to terminate ${monthToMonthNotice}.</p>`
    : `<p>This is a fixed-term lease beginning <strong>${leaseStart}</strong>, and ending <strong>${leaseEnd}</strong>.</p>
<p>This Agreement automatically terminates at the end of the lease term and does not convert to a month-to-month tenancy unless both parties agree in writing.</p>
<p>Resident agrees to vacate the Premises no later than <strong>12:00 PM</strong> on the final day of the lease term.${holdoverClause}</p>
${earlyTerminationBlock(input)}`;

  return `
<h1>RESIDENTIAL ROOM LEASE AGREEMENT</h1>
<p class="sub" style="font-weight:700;text-transform:uppercase;letter-spacing:.06em">${escapeHtml(config.headerSubtitle)}</p>
${propertyTemplatePreview ? "" : `<p class="generated">Generated ${generatedDate} via PropLane</p>`}
${leaseSummaryHtml}
${disclosureReviewNotice}

<h2>1. Parties and Premises</h2>
<p>This Residential Room Lease Agreement is entered into between <strong>${landlordEntity}</strong> (&ldquo;Landlord&rdquo;) and <strong>${tenantName}</strong> (&ldquo;Resident&rdquo;).</p>
${
  !input.propertyTemplatePreview && (input.tenantPhone || input.tenantEmail || input.tenantDob)
    ? `<p>Resident contact: ${[
        input.tenantPhone ? `Phone ${input.tenantPhone}` : "",
        input.tenantEmail ? `Email ${input.tenantEmail}` : "",
        input.tenantDob ? `Date of birth: ${input.tenantDob}` : "",
      ]
        .filter(Boolean)
        .join(" · ")}</p>`
    : ""
}
<p>Landlord leases to Resident the private bedroom identified as <strong>${roomLabel}</strong> located at: <strong>${address}${cityZip ? `, ${escapeHtml(cityZip)}` : ""}</strong> (&ldquo;Premises&rdquo;).</p>
<p>${premisesAccess}</p>

<h2>2. Lease Term</h2>
${leaseTermSection}

<h2>3. Rent and Utilities</h2>
<p>Resident agrees to pay:</p>
<p><strong>Rent:</strong> ${monthlyRentDisplay}<br/>
<strong>Utilities:</strong> ${utilitiesDisplay}</p>
${monthlyCustomFeeLines}
${supplementalOneTimeFeeLines}
${prorationLine}
<p>${paymentInstruction}</p>
<p>Failure to pay rent, utilities, fees, or other charges when due may constitute a default under this Agreement and applicable Washington law.</p>

<h2>4. Move-In Payment Summary</h2>
${moveInPaymentSummaryHtml(input)}

<h2>5. Security Deposit</h2>
<p>Resident shall pay a refundable security deposit of <strong>${secDep}</strong>.</p>
<p>The security deposit secures Resident&apos;s performance of this Agreement and may be used for lawful deductions including:</p>
<ul>
  <li>Unpaid rent</li>
  <li>Damage beyond ordinary wear and tear</li>
  <li>Excessive cleaning</li>
  <li>Missing keys</li>
  <li>Lost or damaged furnishings</li>
  <li>Other charges permitted by Washington law</li>
</ul>
<p>${input.config.depositReturnWindow ?? "Any refundable balance shall be returned in accordance with Washington law after Resident vacates and provides a forwarding address."}</p>
<p>The security deposit may not be used as the final month&apos;s rent.</p>

<h2>6. Utilities</h2>
<p>Resident shall pay monthly utilities of <strong>${utilitiesDisplay}</strong>.</p>
${input.utilitiesBreakdown ?? ""}
${input.utilitiesEstimateSentence ? `<p>${input.utilitiesEstimateSentence}</p>` : ""}
${utilitiesBullets}
<p>Utilities are provided for ordinary residential use only. Excessive or abusive usage may result in additional charges if permitted by law.</p>

<h2>7. Occupancy</h2>
<p>Only <strong>${tenantName}</strong> may occupy the Premises.</p>
<p>Resident shall not permit another individual to reside in the room without prior written approval from Landlord.</p>
<p>The Premises shall be used solely for residential purposes.</p>

<h2>8. House Rules</h2>
<p>Resident agrees to:</p>
${houseRulesBlock}

<h2>9. Furnishings</h2>
<p>Any furniture or appliances supplied by Landlord remain the property of Landlord.</p>
<p>Resident shall exercise reasonable care while using all furnishings and shall be responsible for damage beyond normal wear and tear.</p>
<p>Landlord is not responsible for loss or theft of Resident&apos;s personal belongings.</p>

<h2>10. Maintenance</h2>
<p>Landlord shall maintain the property in compliance with applicable Washington law, including adequate heating capable of maintaining ${input.config.minimumHeatTemperature ?? "the minimum temperature required by applicable law"}, and functioning plumbing and hot water. Resident agrees to:</p>
<ul>
  <li>Promptly report maintenance problems.</li>
  <li>Avoid damaging the property.</li>
  <li>Maintain reasonable cleanliness.</li>
  <li>Use appliances properly.</li>
</ul>
<p>Resident shall be responsible for damage caused by Resident or Resident&apos;s guests.</p>

<h2>11. Entry</h2>
<p>Landlord may enter the private room after providing notice required under Washington law for inspections, repairs, maintenance, or showing the room.</p>
<p>Landlord may enter immediately without prior notice during emergencies involving health, safety, or protection of property.</p>
<p>Landlord and authorized representatives may access shared/common areas at any time for purposes including maintenance, inspections, cleaning, repairs, safety checks, or management of the property. Residents do not have exclusive possession of shared areas.</p>

<h2>12. Pets and Smoking</h2>
<p>No pets are permitted without prior written approval.</p>
<p>Smoking, vaping, or use of tobacco or cannabis products is prohibited inside the residence.</p>

<h2>13. Subletting or Assignment</h2>
<p>Resident may not assign, transfer, or sublease this Agreement without prior written consent from Landlord.</p>
<p>Unauthorized occupancy constitutes a material violation of this Agreement.</p>

<h2>14. Alterations</h2>
<p>Resident shall not paint, drill into walls, install fixtures, or otherwise alter the Premises without prior written permission.</p>

<h2>15. Move-Out</h2>
<p>At the conclusion of the lease, Resident shall:</p>
<ul>
  <li>Vacate the room on time.</li>
  <li>Remove all personal property.</li>
  <li>Return all keys.</li>
  <li>Leave the room reasonably clean.</li>
  <li>Return the Premises in substantially the same condition as received, excluding normal wear and tear.</li>
</ul>
<p>Cleaning or repair costs, including costs related to the resident&apos;s private room and shared/common areas, resulting from the Resident&apos;s occupancy, misuse, damage, excessive mess, or failure to maintain the premises as required may be deducted from the security deposit as permitted under applicable law.</p>

<h2>16. Default</h2>
<p>Failure to pay rent, utilities, fees, or comply with the terms of this Agreement may result in notices, termination of tenancy, eviction proceedings, or other remedies available under Washington law.</p>
<p>Landlord&apos;s acceptance of late or partial payment does not waive any rights under this Agreement.</p>

<h2>17. General Provisions</h2>
<p>If any provision of this Agreement is determined to be unenforceable, the remaining provisions shall remain in effect.</p>
<p>Any amendments to this Agreement must be made in writing and signed by both parties.</p>
<p>This Agreement represents the complete understanding between the parties regarding the Premises.</p>

<h2>18. Governing Law</h2>
<p>This Agreement shall be governed by the laws of the State of Washington, including the Washington Residential Landlord-Tenant Act (RCW Chapter 59.18).</p>
<p>Any legal proceeding arising from this Agreement shall be brought in the appropriate court located in ${escapeHtml(disputeVenue)}, unless otherwise required by law.</p>

<h2>19. Entire Agreement</h2>
<p>This Agreement contains the entire agreement between Landlord and Resident and supersedes all prior discussions or understandings relating to the Premises.</p>
<p>No oral statements or promises shall modify this Agreement.</p>

<h2>20. Addenda</h2>
<p>The following addenda are incorporated into and made part of this Agreement:</p>

<div class="addendum page-break">
<h2>Addendum A — Move-In Condition Report</h2>
<p>Resident and Landlord agree to complete and sign this report within 5 days of move-in. Resident may document any pre-existing damage and return it to Landlord by email. Absent a completed report, the room shall be deemed to be in clean, undamaged condition at move-in.</p>
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
<p>Landlord discloses that, to Landlord&apos;s knowledge as of the date of this Agreement, there is no known active bed bug infestation in the unit or building. Resident shall inspect the room upon move-in and report any signs of bed bugs immediately. If an infestation is discovered during the tenancy, Resident shall notify Landlord in writing within 24 hours and cooperate with any required inspection or treatment. Resident shall not introduce second-hand mattresses, upholstered furniture, or bedding without prior written approval. Resident is responsible for infestation caused by Resident&apos;s belongings or guests.</p>
</div>

<div class="addendum">
<h2>Addendum C — Mold &amp; Moisture Policy</h2>
<p>Resident agrees to maintain adequate ventilation in the room and bathroom (open windows when possible, use exhaust fans). Resident shall promptly report visible mold, moisture intrusion, or condensation to Landlord in writing. Resident shall wipe down surfaces subject to moisture (shower walls, windowsills) regularly. Resident shall not dry laundry inside the room or any space without adequate ventilation. Failure to report mold or moisture conditions within 24 hours of discovery may result in Resident being held liable for resulting damage (${escapeHtml(residentMaintenanceStatuteRef)}).</p>
</div>

<div class="addendum">
<h2>Addendum D — Maintenance &amp; Tenant Responsibilities Detail</h2>
<ul>
  <li><strong>Light bulbs:</strong> Resident is responsible for replacing standard bulbs in their room.</li>
  <li><strong>Smoke &amp; CO detectors:</strong> Test monthly; replace batteries as needed; never disable. Report any malfunctioning detector within 24 hours.</li>
  <li><strong>HVAC filters (in-room):</strong> Replace or clean as recommended by Landlord, typically every 60–90 days.</li>
  <li><strong>Drains:</strong> Keep shower/sink drains free of hair and debris. Use drain covers. Do not pour grease down any drain.</li>
  <li><strong>Appliances:</strong> Report any malfunction immediately. Do not attempt to repair appliances. Clean appliances (microwave, oven) after each use.</li>
  <li><strong>Damage reporting:</strong> Report all damage, leaks, pests, or safety hazards to Landlord within 24 hours of discovery.</li>
  <li><strong>Emergencies:</strong> In the event of fire, gas leak, flooding, or other emergency, call 911 immediately, then notify Landlord.</li>
</ul>
</div>

<div class="addendum">
<h2>Addendum E — House Rules Enforcement</h2>
<p><strong>Noise &amp; nuisance:</strong> Quiet hours are strictly enforced (${quietHours}). Violations will result in a written warning for the first offense, a <strong>$50</strong> fine for the second offense, and potential termination proceedings for subsequent violations.</p>
<p><strong>Guest violations:</strong> Unauthorized overnight guests beyond policy limits will result in a written warning. Repeated violations are grounds for a 10-day cure notice.</p>
<p><strong>Cleaning violations:</strong> If common areas are left unsanitary and the responsible resident does not remedy within 24 hours of notice, Landlord may arrange cleaning at Resident&apos;s expense (<strong>$50</strong> minimum).</p>
<p><strong>Dispute resolution:</strong> Residents are encouraged to resolve disputes between themselves first. If unresolved, bring concerns to Landlord in writing. Landlord&apos;s reasonable determination of house-rule disputes shall be final subject to applicable law.</p>
<p><strong>Three-strike policy:</strong> Three documented written warnings in any 12-month period for the same or similar violations may constitute grounds for lease termination with appropriate statutory notice.</p>
</div>
${customTermsAddendumHtml}
${
  input.leadDisclosureHtml
    ? `<h2>Lead-Based Paint Disclosure</h2>
${input.leadDisclosureHtml}`
    : ""
}

<h2>21. Signatures</h2>
<p><strong>Landlord</strong> and <strong>Resident</strong> each execute this Agreement <strong>once</strong> through the PropLane portal. The <strong>Electronic Signature Certificate</strong> appended to the signed copy is the binding record for both parties. No duplicate handwritten signature lines are included in this document.</p>
<p>Security deposits are held in accordance with ${escapeHtml(depositStatuteRef)}.</p>
`;
}
