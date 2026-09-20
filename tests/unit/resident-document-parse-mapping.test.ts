import { describe, expect, it } from "vitest";
import {
  fillOnlyBlank,
  mapParsedFieldsToApplicationAnswers,
} from "@/lib/resident-document-import/apply-parsed-to-add-resident";

describe("mapParsedFieldsToApplicationAnswers", () => {
  it("maps applicant keys with a 'from file' mark, and 'check' for low confidence", () => {
    const fill = mapParsedFieldsToApplicationAnswers([
      { key: "employer", value: "Puget Sound Energy", confidence: "high" },
      { key: "dateOfBirth", value: "03/14/1996", confidence: "low" },
      { key: "monthlyIncome", value: "$5,400", confidence: "medium" },
      { key: "evictionHistory", value: "no", confidence: "high" },
      { key: "tenantName", value: "Maya Chen", confidence: "high" },
    ]);
    expect(fill.answers.employer).toBe("Puget Sound Energy");
    expect(fill.answers.dateOfBirth).toBe("1996-03-14");
    expect(fill.answers.monthlyIncome).toBe("5400");
    expect(fill.answers.evictionHistory).toBe("No");
    expect(fill.marks).toEqual({ employer: "fromFile", dateOfBirth: "check", monthlyIncome: "fromFile", evictionHistory: "fromFile" });
    // Contact keys belong to the contact step, not the application block.
    expect("tenantName" in fill.answers).toBe(false);
  });

  it("never carries an SSN, whatever the parser returns", () => {
    const fill = mapParsedFieldsToApplicationAnswers([{ key: "ssn", value: "123-45-6789", confidence: "high" }]);
    expect(fill.answers).toEqual({});
  });

  it("drops a yes/no answer it cannot read rather than guessing", () => {
    const fill = mapParsedFieldsToApplicationAnswers([{ key: "criminalHistory", value: "see attached", confidence: "high" }]);
    expect(fill.answers.criminalHistory).toBeUndefined();
  });
});

describe("fillOnlyBlank", () => {
  it("fills blanks and never overwrites what the manager typed", () => {
    const { next, filledKeys } = fillOnlyBlank(
      { name: "Maya Chen", email: "", phone: "  " },
      { name: "M. Chen", email: "maya@x.io", phone: "206" },
    );
    expect(next).toEqual({ name: "Maya Chen", email: "maya@x.io", phone: "206" });
    expect(filledKeys).toEqual(["email", "phone"]);
  });

  it("restores exactly with the snapshot taken before the fill (Undo)", () => {
    const before = { name: "", email: "typed@x.io" };
    const { next } = fillOnlyBlank(before, { name: "Maya", email: "parsed@x.io" });
    expect(next).toEqual({ name: "Maya", email: "typed@x.io" });
    expect(before).toEqual({ name: "", email: "typed@x.io" });
  });
});
