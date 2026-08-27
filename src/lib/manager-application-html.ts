import type { DemoApplicantRow } from "@/data/demo-portal";
import type { CosignerSubmission } from "@/lib/cosigner-submissions-storage";
import type { RentalWizardFormState } from "@/lib/rental-application/types";
import {
  displayableCustomFieldAnswers,
  formatCustomFieldAnswerDisplay,
} from "@/lib/rental-application/custom-fields";
import { formatLeaseDateLabel } from "@/lib/rental-application/lease-dates";
import { digitsOnly } from "@/lib/rental-application/masks";
import { applicantDisplayName } from "@/lib/rental-application/applicant-name";
import {
  applicationStageDisplayLabel,
  INCOMPLETE_APPLICATION_LABEL,
  isInProgressApplicationRow,
} from "@/lib/rental-application/in-progress-application";
import type { ApplicationGroupMember } from "@/lib/rental-application/application-groups";
import { applicationGroupMemberStatusLabel } from "@/lib/rental-application/application-groups";
import { formatApplicationGroupMemberLine } from "@/lib/application-group-document";
import { leaseCss } from "@/lib/lease-templates/types";

export type Field = { label: string; value: string };

export function clean(value: unknown): string {
  return String(value ?? "").trim();
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function money(value: string | number | undefined | null): string {
  const raw = clean(value);
  if (!raw) return "";
  if (raw.startsWith("$")) return raw;
  const n = Number.parseFloat(raw.replace(/[^0-9.]+/g, ""));
  return Number.isFinite(n) && n > 0 ? `$${n.toFixed(2)}` : raw;
}

function yesNo(value: string | null | undefined): string {
  const v = clean(value).toLowerCase();
  if (v === "yes") return "Yes";
  if (v === "no") return "No";
  return "";
}

function statusLabel(row: DemoApplicantRow): string {
  if (row.bucket === "approved") return "Approved";
  if (row.bucket === "rejected") return "Rejected";
  if (isInProgressApplicationRow(row)) return INCOMPLETE_APPLICATION_LABEL;
  return "Pending review";
}

/** Never render full digits — last 4 only, matching the review-screen SSN mask. */
function maskSsn(ssn: string | null | undefined): string {
  const d = digitsOnly(clean(ssn));
  if (d.length !== 9) return "";
  return `•••-••-${d.slice(5)}`;
}

/** Co-signer SSNs are already masked at submission-storage time; re-mask defensively if a raw value ever reaches here. */
function maskCosignerSsn(ssn: string | null | undefined): string {
  const raw = clean(ssn);
  if (!raw) return "";
  if (raw.includes("*")) return raw;
  return maskSsn(raw);
}

function cosignerBankruptcyLabel(value: string | undefined): string {
  if (value === "never") return "Never filed";
  if (value === "past_discharged") return "Past (discharged)";
  if (value === "current") return "Current / active";
  return "";
}

function cosignerCriminalLabel(value: string | undefined): string {
  return yesNo(value);
}

/** One "Co-signer" section per submitted co-signer form, numbered when there is more than one. */
function cosignerSections(submissions: CosignerSubmission[] | undefined): string {
  const list = Array.isArray(submissions) ? submissions : [];
  return list
    .map((sub, i) => {
      const title = list.length > 1 ? `Co-signer ${i + 1}` : "Co-signer";
      const address = [
        clean(sub.address),
        [clean(sub.city), clean(sub.state)].filter(Boolean).join(", "),
        clean(sub.zip),
      ]
        .filter(Boolean)
        .join("  ");
      return section(title, [
        { label: "Legal name", value: clean(sub.fullName) },
        { label: "Email", value: clean(sub.email) },
        { label: "Phone", value: clean(sub.phone) },
        { label: "Date of birth", value: clean(sub.dob) },
        { label: "ID number", value: clean(sub.dlNumber) },
        { label: "SSN", value: maskCosignerSsn(sub.ssn) },
        { label: "Address", value: address },
        { label: "Employment", value: sub.notEmployed ? "Not currently employed" : "" },
        { label: "Employer", value: clean(sub.employerName) },
        { label: "Employer address", value: clean(sub.employerAddress) },
        { label: "Job title", value: clean(sub.jobTitle) },
        { label: "Supervisor", value: clean(sub.supervisorName) },
        { label: "Supervisor phone", value: clean(sub.supervisorPhone) },
        { label: "Employment start", value: clean(sub.employmentStart) },
        { label: "Monthly income", value: money(sub.monthlyIncome) },
        { label: "Annual income", value: money(sub.annualIncome) },
        { label: "Other income", value: clean(sub.otherIncome) },
        { label: "Bankruptcy", value: cosignerBankruptcyLabel(sub.bankruptcy) },
        { label: "Criminal history", value: cosignerCriminalLabel(sub.criminal) },
        { label: "Credit/background consent", value: sub.consentCredit ? "Authorized" : "" },
        { label: "Signature", value: clean(sub.signature) },
        { label: "Date signed", value: clean(sub.dateSigned) },
        { label: "Submitted", value: sub.submittedAt ? new Date(sub.submittedAt).toLocaleString("en-US", { dateStyle: "long", timeStyle: "short" }) : "" },
      ]);
    })
    .join("\n");
}

function groupRoleLabel(role: RentalWizardFormState["groupRole"] | undefined): string {
  if (role === "first") return "First applicant";
  if (role === "joining") return "Joining group";
  return "";
}

function feeChannelLabel(channel: RentalWizardFormState["applicationFeePayChannel"] | undefined): string {
  switch (channel) {
    case "ach":
      return "ACH";
    case "zelle":
      return "Zelle";
    case "venmo":
      return "Venmo";
    case "stripe":
      return "Card (Stripe)";
    case "other":
      return "Other";
    default:
      return "";
  }
}

/** `<h2>` + label/value table for the populated fields; empty string when nothing is populated. */
export function section(title: string, fields: Field[]): string {
  const populated = fields.filter((f) => f.value.trim());
  if (populated.length === 0) return "";
  const rows = populated
    .map((f) => `<tr><th width="35%">${escapeHtml(f.label)}</th><td>${escapeHtml(f.value)}</td></tr>`)
    .join("\n  ");
  return `
<h2>${escapeHtml(title)}</h2>
<table>
  ${rows}
</table>`;
}

export function freeTextSection(title: string, body: string): string {
  const text = body.trim();
  if (!text) return "";
  return `
<h2>${escapeHtml(title)}</h2>
<p>${escapeHtml(text)}</p>`;
}

export type ApplicationHtmlOptions = {
  /** Human room label resolved on the client (listing catalog is not available server-side). */
  roomLabel?: string;
  /** ISO generation timestamp; defaults to now. */
  generatedAt?: string;
  /** Co-signer application(s) submitted against this applicant's Axis ID, if any. */
  cosignerSubmissions?: CosignerSubmission[];
  /** Other applicants in the same group application (excludes this row when provided). */
  groupMembers?: ApplicationGroupMember[];
  /**
   * Unauthenticated public share link — only an allowlisted summary is rendered.
   * Contact info, residence, employment, references, disclosures, cosigners, and
   * manager-only fields are omitted entirely.
   */
  publicShare?: boolean;
};

/**
 * Clean rendered-document view of a rental application, matching the lease
 * document presentation (white page, serif, section tables). Mirrors the
 * content of buildApplicationPdf; meant for an `srcDoc` iframe so managers can
 * read the application without the browser's PDF-viewer chrome.
 */
function formatApplicationGroupMemberPublicLine(member: ApplicationGroupMember): string {
  return [member.name, applicationGroupMemberStatusLabel(member.status)].filter(Boolean).join(" · ");
}

function buildPublicShareApplicationBody(
  row: DemoApplicantRow,
  options: ApplicationHtmlOptions,
  applicantName: string,
  axisId: string,
  generatedLabel: string,
  roomLabel: string,
): string {
  const app: Partial<RentalWizardFormState> = row.application ?? {};
  const otherGroupMembers = (options.groupMembers ?? []).filter((m) => m.id !== row.id);

  return `
<h1>PROPLANE ${app.rentalType === "short_term" ? "SHORT-TERM STAY APPLICATION" : "RENTAL APPLICATION"}</h1>
<p class="sub">PropLane · Shared application summary</p>
<p class="generated">PropLane ID ${escapeHtml(axisId)} · ${escapeHtml(statusLabel(row))} · Generated ${escapeHtml(generatedLabel)}</p>

${section("Application summary", [
  { label: "Applicant", value: applicantName },
  { label: "Property", value: clean(row.property) || "—" },
  { label: "Room", value: roomLabel || clean(app.roomChoice1) || "—" },
  { label: "Move-in date", value: formatLeaseDateLabel(app.leaseStart) || clean(app.leaseStart) || "—" },
  { label: "Application status", value: statusLabel(row) },
  { label: "Stage", value: applicationStageDisplayLabel(row) },
])}

${section("Property & room", [
  { label: "Property", value: clean(row.property) },
  { label: "Room", value: roomLabel || clean(app.roomChoice1) },
  {
    label: "Rental type",
    value: app.rentalType === "short_term" ? "Short-term stay" : app.rentalType ? "Standard lease" : "",
  },
  { label: "Stay type / term", value: clean(app.leaseTerm) },
  { label: "Move-in date", value: formatLeaseDateLabel(app.leaseStart) || clean(app.leaseStart) },
  { label: "Lease end / move-out", value: formatLeaseDateLabel(app.leaseEnd) || clean(app.leaseEnd) },
])}

${section("Household", [
  { label: "Applying as a group", value: yesNo(app.applyingAsGroup) },
  { label: "Group role", value: groupRoleLabel(app.groupRole) },
  { label: "Group size", value: app.groupRole === "joining" ? "" : clean(app.groupSize) },
  { label: "Group ID", value: app.applyingAsGroup === "yes" ? clean(app.groupId) : "" },
  { label: "Has co-signer", value: yesNo(app.hasCosigner) },
])}

${
  otherGroupMembers.length > 0
    ? section(
        "Other group application members",
        otherGroupMembers.map((member, index) => ({
          label: `Member ${index + 1}`,
          value: formatApplicationGroupMemberPublicLine(member),
        })),
      )
    : ""
}

<p class="footnote">Shared via PropLane. This summary omits contact information, financial details, residence history, references, screening answers, and identity documents. PropLane · Confidential</p>
`;
}

export function buildApplicationHtml(row: DemoApplicantRow, options: ApplicationHtmlOptions = {}): string {
  const app: Partial<RentalWizardFormState> = row.application ?? {};
  const applicantName = clean(app.fullLegalName) || applicantDisplayName(row);
  const axisId = clean(row.id) || "—";
  const generated = options.generatedAt ? new Date(options.generatedAt) : new Date();
  const generatedLabel = generated.toLocaleString("en-US", { dateStyle: "long", timeStyle: "short" });
  const roomLabel = clean(options.roomLabel);

  const otherGroupMembers = (options.groupMembers ?? []).filter((m) => m.id !== row.id);

  const signedRent =
    row.signedMonthlyRent && row.signedMonthlyRent > 0
      ? `$${row.signedMonthlyRent.toFixed(2)} / month`
      : money(app.managerRentOverride);

  const currentAddress = [
    clean(app.currentStreet),
    [clean(app.currentCity), clean(app.currentState)].filter(Boolean).join(", "),
    clean(app.currentZip),
  ]
    .filter(Boolean)
    .join("  ");
  const prevAddress = [
    clean(app.prevStreet),
    [clean(app.prevCity), clean(app.prevState)].filter(Boolean).join(", "),
    clean(app.prevZip),
  ]
    .filter(Boolean)
    .join("  ");

  const body = options.publicShare
    ? buildPublicShareApplicationBody(row, options, applicantName, axisId, generatedLabel, roomLabel)
    : `
<h1>PROPLANE ${app.rentalType === "short_term" ? "SHORT-TERM STAY APPLICATION" : "RENTAL APPLICATION"}</h1>
<p class="sub">PropLane · Official application record</p>
<p class="generated">PropLane ID ${escapeHtml(axisId)} · ${escapeHtml(statusLabel(row))} · Generated ${escapeHtml(generatedLabel)}</p>

${section("Application summary", [
  { label: "Applicant", value: applicantName },
  { label: "Property", value: clean(row.property) || "—" },
  { label: "Room", value: roomLabel || clean(app.roomChoice1) || "—" },
  { label: "Move-in date", value: formatLeaseDateLabel(app.leaseStart) || clean(app.leaseStart) || "—" },
  { label: "Signed monthly rent", value: signedRent || "—" },
])}

${section("Applicant details", [
  { label: "Full legal name", value: applicantName },
  { label: "Email", value: clean(app.email) || clean(row.email) },
  { label: "Phone", value: clean(app.phone) },
  { label: "Date of birth", value: clean(app.dateOfBirth) },
  { label: "SSN", value: maskSsn(app.ssn) },
  { label: "Driver's license", value: clean(app.driversLicense) },
  { label: "Application status", value: statusLabel(row) },
  { label: "Stage", value: applicationStageDisplayLabel(row) },
])}

${section("Property & room", [
  { label: "Property", value: clean(row.property) },
  { label: "Room", value: roomLabel || clean(app.roomChoice1) },
  { label: "Second choice", value: roomLabel ? "" : clean(app.roomChoice2) },
  { label: "Third choice", value: roomLabel ? "" : clean(app.roomChoice3) },
  {
    label: "Rental type",
    value: app.rentalType === "short_term" ? "Short-term stay" : app.rentalType ? "Standard lease" : "",
  },
  { label: "Stay type / term", value: clean(app.leaseTerm) },
  { label: "Move-in date", value: formatLeaseDateLabel(app.leaseStart) || clean(app.leaseStart) },
  { label: "Lease end / move-out", value: formatLeaseDateLabel(app.leaseEnd) || clean(app.leaseEnd) },
  { label: "Check-in time", value: app.rentalType === "short_term" ? clean(app.shortTermCheckInTime) : "" },
  { label: "Check-out time", value: app.rentalType === "short_term" ? clean(app.shortTermCheckOutTime) : "" },
  { label: "Signed monthly rent", value: signedRent },
  { label: "Utilities", value: money(app.managerUtilitiesOverride) },
  { label: "Security deposit", value: money(app.managerSecurityDepositOverride) },
  { label: "Move-in cost", value: money(app.managerMoveInFeeOverride) },
  { label: clean(app.managerOtherCostLabel) || "Other cost", value: money(app.managerOtherCostAmount) },
])}

${section("Household", [
  { label: "Applying as a group", value: yesNo(app.applyingAsGroup) },
  { label: "Group role", value: groupRoleLabel(app.groupRole) },
  { label: "Group size", value: app.groupRole === "joining" ? "" : clean(app.groupSize) },
  // The first applicant now also carries the shared Group ID (minted at submit), so show it for either role.
  { label: "Group ID", value: app.applyingAsGroup === "yes" ? clean(app.groupId) : "" },
  { label: "Has co-signer", value: yesNo(app.hasCosigner) },
  { label: "Occupants", value: clean(app.occupancyCount) },
  { label: "Pets", value: clean(app.pets) },
])}

${
  otherGroupMembers.length > 0
    ? section(
        "Other group application members",
        otherGroupMembers.map((member, index) => ({
          label: `Member ${index + 1}`,
          value: formatApplicationGroupMemberLine(member),
        })),
      )
    : ""
}

${cosignerSections(options.cosignerSubmissions)}

${section("Current residence", [
  { label: "Address", value: currentAddress },
  { label: "Landlord", value: clean(app.currentLandlordName) },
  { label: "Landlord phone", value: clean(app.currentLandlordPhone) },
  { label: "Move in", value: clean(app.currentMoveIn) },
  { label: "Move out", value: clean(app.currentMoveOut) },
  { label: "Reason for leaving", value: clean(app.currentReasonLeaving) },
])}

${
  app.noPreviousAddress
    ? ""
    : section("Previous residence", [
        { label: "Address", value: prevAddress },
        { label: "Landlord", value: clean(app.prevLandlordName) },
        { label: "Landlord phone", value: clean(app.prevLandlordPhone) },
        { label: "Move in", value: clean(app.prevMoveIn) },
        { label: "Move out", value: clean(app.prevMoveOut) },
        { label: "Reason for leaving", value: clean(app.prevReasonLeaving) },
      ])
}

${section("Employment & income", [
  { label: "Employment", value: app.notEmployed ? "Not currently employed" : "" },
  { label: "Employer", value: clean(app.employer) },
  { label: "Employer address", value: clean(app.employerAddress) },
  { label: "Job title", value: clean(app.jobTitle) },
  { label: "Supervisor", value: clean(app.supervisorName) },
  { label: "Supervisor phone", value: clean(app.supervisorPhone) },
  { label: "Employment start", value: clean(app.employmentStart) },
  { label: "Monthly income", value: money(app.monthlyIncome) },
  { label: "Annual income", value: money(app.annualIncome) },
  { label: "Other income", value: clean(app.otherIncome) },
])}

${section("References", [
  {
    label: "Reference 1",
    value: [clean(app.ref1Name), clean(app.ref1Relationship), clean(app.ref1Phone)].filter(Boolean).join(" · "),
  },
  {
    label: "Reference 2",
    value: [clean(app.ref2Name), clean(app.ref2Relationship), clean(app.ref2Phone)].filter(Boolean).join(" · "),
  },
])}

${section(
  "Manager questions",
  displayableCustomFieldAnswers(app.customFieldAnswers).map((answer) => ({
    label: answer.label,
    value: formatCustomFieldAnswerDisplay(answer),
  })),
)}

${section("Disclosures", [
  { label: "Prior eviction", value: yesNo(app.evictionHistory) },
  { label: "Eviction details", value: clean(app.evictionDetails) },
  { label: "Bankruptcy", value: yesNo(app.bankruptcyHistory) },
  { label: "Bankruptcy details", value: clean(app.bankruptcyDetails) },
  { label: "Criminal history", value: yesNo(app.criminalHistory) },
  { label: "Criminal details", value: clean(app.criminalDetails) },
])}

${section("Consent & signature", [
  { label: "Credit/background consent", value: app.consentCredit ? "Authorized" : "" },
  {
    label: "House rules acknowledged",
    value: app.rentalType === "short_term" && app.shortTermRulesAck ? "Acknowledged" : "",
  },
  { label: "Attestation of truth", value: app.consentTruth ? "Acknowledged" : "" },
  { label: "Application fee acknowledged", value: app.applicationFeeAcknowledged ? "Yes" : "" },
  { label: "Application fee payment method", value: feeChannelLabel(app.applicationFeePayChannel) },
  {
    label: "Manual fee payment confirmed",
    value:
      app.applicationFeePayChannel === "zelle" || app.applicationFeePayChannel === "venmo"
        ? yesNo(app.applicationFeeZelleSentConfirmed ? "yes" : "no")
        : "",
  },
  { label: "Digital signature", value: clean(app.digitalSignature) },
  { label: "Date signed", value: clean(app.dateSigned) },
])}

${freeTextSection("Manager notes", clean(row.detail))}

<p class="footnote">Generated from PropLane application records. Amounts and placement can change later in the lease or payment portal. PropLane · Confidential</p>
`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Rental Application — ${escapeHtml(applicantName)}</title>
  <style>${leaseCss()}
    html, body { background: #fff; }
    .footnote { margin-top: 2.4rem; border-top: 1px solid #ccc; padding-top: 0.8rem; font-size: 0.8rem; font-style: italic; color: #777; }
  </style>
</head>
<body>
${body}
</body>
</html>`;
}
