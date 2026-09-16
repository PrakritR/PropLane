import {
  CANONICAL_DEMO_GUIDED_EMAIL,
  CANONICAL_DEMO_GUIDED_NAME,
} from "@/lib/demo/demo-canonical-accounts";
import { getRoomOptionsForProperty } from "@/lib/rental-application/data";
import { computeLeaseEndDate } from "@/lib/rental-application/lease-dates";
import { createInitialRentalWizardState, todayISO } from "@/lib/rental-application/state";
import type { RentalWizardFormState } from "@/lib/rental-application/types";

/**
 * Valid rental wizard state for demo autoplay on a freshly listed property.
 * The applicant is the canonical sandbox test account and every other field is
 * an obvious placeholder — the walkthrough must never put an invented person,
 * employer, or landlord on screen as if they were a real record.
 */
/** First day of the month after this one, as YYYY-MM-DD, so the demo never offers a past date. */
function firstOfNextMonthIso(): string {
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const month = String(next.getMonth() + 1).padStart(2, "0");
  return `${next.getFullYear()}-${month}-01`;
}

export function buildDemoApplicationAutofill(propertyId: string): RentalWizardFormState {
  const pid = propertyId.trim();
  const rooms = getRoomOptionsForProperty(pid, { includeUnavailable: true }).filter((o) => o.value);
  const roomChoice1 = rooms[0]?.value ?? "";
  const roomChoice2 = rooms[1]?.value ?? "";
  const leaseTerm = "12-Month";
  // The first of NEXT month, never a hardcoded date. A literal here silently expires: it was
  // "2026-08-01", so from 2026-08-02 the guided demo autofilled a lease start in the past and
  // the wizard refused to advance with "Lease start date cannot be in the past."
  const leaseStart = firstOfNextMonthIso();
  const leaseEnd = computeLeaseEndDate(leaseStart, leaseTerm);
  const base = createInitialRentalWizardState();

  return {
    ...base,
    applyingAsGroup: "no",
    hasCosigner: "no",
    propertyId: pid,
    roomChoice1,
    roomChoice2,
    roomChoice3: "",
    leaseTerm,
    leaseStart,
    leaseEnd,
    fullLegalName: CANONICAL_DEMO_GUIDED_NAME,
    dateOfBirth: "1995-06-15",
    ssn: "123-45-6789",
    driversLicense: "WA DL WDL12AB345CD",
    phone: "(206) 555-0142",
    email: CANONICAL_DEMO_GUIDED_EMAIL,
    currentStreet: "100 Example St",
    currentCity: "Seattle",
    currentState: "WA",
    currentZip: "98101",
    currentLandlordName: "Sample Property Co.",
    currentLandlordPhone: "(206) 555-0199",
    currentMoveIn: "2024-08-01",
    currentMoveOut: "2026-07-31",
    currentReasonLeaving: "Sample answer — relocating for work.",
    noPreviousAddress: false,
    prevStreet: "200 Example St",
    prevCity: "Seattle",
    prevState: "WA",
    prevZip: "98105",
    prevLandlordName: "Sample Housing Office",
    prevLandlordPhone: "(206) 555-0100",
    prevMoveIn: "2022-09-01",
    prevMoveOut: "2024-07-15",
    prevReasonLeaving: "Sample answer — end of term.",
    notEmployed: false,
    employer: "Sample Employer",
    employerAddress: "200 Example Ave, Seattle, WA",
    supervisorName: "Sample Supervisor",
    supervisorPhone: "(206) 555-0177",
    jobTitle: "Sample job title",
    monthlyIncome: "4,850",
    annualIncome: "58,200",
    employmentStart: "2024-09-01",
    otherIncome: "",
    ref1Name: "Sample Reference One",
    ref1Relationship: "Former roommate",
    ref1Phone: "(425) 555-0133",
    ref2Name: "Sample Reference Two",
    ref2Relationship: "Coworker",
    ref2Phone: "(206) 555-0166",
    occupancyCount: "1",
    pets: "None",
    evictionHistory: "no",
    bankruptcyHistory: "no",
    criminalHistory: "no",
    consentCredit: true,
    consentTruth: true,
    digitalSignature: CANONICAL_DEMO_GUIDED_NAME,
    dateSigned: todayISO(),
    applicationFeeAcknowledged: true,
    applicationFeePayChannel: "stripe",
    customFieldAnswers: [],
  };
}
