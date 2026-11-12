import { describe, expect, it } from "vitest";
import {
  ADVERSE_ACTION_WAIT_BUSINESS_DAYS,
  CFPB_FCRA_RIGHTS_SUMMARY_URL,
  addBusinessDays,
  adverseActionAllowsDecline,
  adverseActionCanceledNotice,
  adverseActionFinalDueAt,
  adverseActionFinalizeAvailability,
  checkrAgencyContact,
  finalAdverseNotice,
  preAdverseNotice,
  usFederalHolidays,
} from "@/lib/screening/adverse-action";

const iso = (date: Date) => date.toISOString().slice(0, 10);

describe("business-day waiting period", () => {
  it("is five business days, skipping weekends", () => {
    expect(ADVERSE_ACTION_WAIT_BUSINESS_DAYS).toBe(5);
    // Monday 2026-11-16 + 5 business days = Monday 2026-11-23
    expect(iso(adverseActionFinalDueAt(new Date("2026-11-16T17:00:00Z")))).toBe("2026-11-23");
    // Thursday 2026-11-12 + 5 = Thursday 2026-11-19 (Sat/Sun skipped)... Fri 13, Mon 16, Tue 17, Wed 18, Thu 19
    expect(iso(adverseActionFinalDueAt(new Date("2026-11-12T17:00:00Z")))).toBe("2026-11-19");
  });

  it("a notice sent on a weekend starts counting on the next business day, and keeps its time of day", () => {
    const due = adverseActionFinalDueAt(new Date("2026-11-14T18:30:00Z")); // Saturday
    expect(iso(due)).toBe("2026-11-20"); // Mon 16, Tue 17, Wed 18, Thu 19, Fri 20
    expect(due.toISOString().slice(11, 16)).toBe("18:30");
  });

  it("skips US federal holidays (Thanksgiving week 2026)", () => {
    expect(usFederalHolidays(2026).has("2026-11-26")).toBe(true);
    // Mon 11-23 + 5: Tue 24, Wed 25, (Thu 26 holiday), Fri 27, Mon 30, Tue Dec 1
    expect(iso(addBusinessDays(new Date("2026-11-23T10:00:00Z"), 5))).toBe("2026-12-01");
  });

  it("observes a Saturday holiday on Friday and a Sunday holiday on Monday", () => {
    expect(usFederalHolidays(2026).has("2026-07-03")).toBe(true); // July 4, 2026 is a Saturday
    expect(usFederalHolidays(2027).has("2027-12-24")).toBe(true); // Dec 25, 2027 is a Saturday
    expect(usFederalHolidays(2027).has("2027-07-05")).toBe(true); // July 4, 2027 is a Sunday
  });
});

describe("when a decline may be saved", () => {
  const base = { reportId: "ord_1" } as const;
  it("refuses with no answer on record", () => {
    expect(adverseActionAllowsDecline(null, "ord_1")).toBe(false);
  });
  it("allows a 'not based on the report' answer for THIS report only", () => {
    expect(adverseActionAllowsDecline({ ...base, stage: "not_based" }, "ord_1")).toBe(true);
    expect(adverseActionAllowsDecline({ ...base, stage: "not_based" }, "ord_2")).toBe(false);
  });
  it("refuses while the pre-adverse notice waits or after it was withdrawn, allows once finalized", () => {
    expect(adverseActionAllowsDecline({ ...base, stage: "pre_adverse_sent" }, "ord_1")).toBe(false);
    expect(adverseActionAllowsDecline({ ...base, stage: "canceled" }, "ord_1")).toBe(false);
    expect(adverseActionAllowsDecline({ ...base, stage: "finalized" }, "ord_1")).toBe(true);
  });
  it("the final notice waits for the due date", () => {
    const facts = { stage: "pre_adverse_sent" as const, finalDueAt: "2026-11-19T17:00:00.000Z" };
    expect(adverseActionFinalizeAvailability(facts, new Date("2026-11-18T17:00:00Z"))).toEqual({ ok: false, reason: "waiting", dueAt: facts.finalDueAt });
    expect(adverseActionFinalizeAvailability(facts, new Date("2026-11-19T17:00:00Z"))).toEqual({ ok: true });
    expect(adverseActionFinalizeAvailability({ stage: "not_based", finalDueAt: null }, new Date())).toEqual({ ok: false, reason: "not_pre_adverse" });
    expect(adverseActionFinalizeAvailability(null, new Date())).toEqual({ ok: false, reason: "not_pre_adverse" });
  });
});

describe("notice wording", () => {
  const agency = { name: "Checkr, Inc.", address: "1 Test St, San Francisco, CA", phone: "(800) 000-0000" };
  const input = { applicantName: "Jane Doe", propertyLabel: "12 Pine St", kind: "decline" as const, reportUrl: "https://proplane.ai/api/screening/adverse-action/report?applicationId=a1", finalDate: "2026-11-19T17:00:00.000Z", agency };

  it("pre-adverse: a copy of the report, the CFPB summary, the agency, the right to dispute, and not final", () => {
    const n = preAdverseNotice(input);
    expect(n.text).toContain(input.reportUrl);
    expect(n.text).toContain(CFPB_FCRA_RIGHTS_SUMMARY_URL);
    expect(n.text).toContain(agency.name);
    expect(n.text).toContain(agency.address);
    expect(n.text).toContain(agency.phone);
    expect(n.text).toMatch(/dispute/i);
    expect(n.text).toMatch(/not a final decision/i);
    expect(n.text).toMatch(/did not make this decision/i);
    expect(n.text).toContain("November 19, 2026");
    expect(n.smsText).toContain(input.reportUrl);
  });

  it("final: same elements plus a statement that the agency did not decide and cannot give reasons", () => {
    const n = finalAdverseNotice(input);
    for (const needle of [input.reportUrl, CFPB_FCRA_RIGHTS_SUMMARY_URL, agency.name, agency.address, agency.phone]) {
      expect(n.text).toContain(needle);
    }
    expect(n.text).toMatch(/did not make this decision/i);
    expect(n.text).toMatch(/unable to provide the specific reasons/i);
    expect(n.text).toMatch(/free copy/i);
    expect(n.text).toMatch(/60 days/);
    expect(n.text).toMatch(/dispute/i);
  });

  it("a conditional approval is worded as conditions, not a decline", () => {
    expect(preAdverseNotice({ ...input, kind: "condition" }).text).toMatch(/added conditions/);
  });

  it("the withdrawn notice says no adverse decision was made", () => {
    expect(adverseActionCanceledNotice({ applicantName: "Jane" }).text).toMatch(/No adverse decision/);
  });

  it("the agency contact is overridable per deployment", () => {
    expect(checkrAgencyContact({ CHECKR_CRA_PHONE: "(111) 222-3333" }).phone).toBe("(111) 222-3333");
    expect(checkrAgencyContact({}).name).toBe("Checkr, Inc.");
  });
});
