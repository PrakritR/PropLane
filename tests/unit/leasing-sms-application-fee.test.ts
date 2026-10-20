import { describe, expect, it } from "vitest";
import { applicationFeeFactsForSms } from "@/lib/tools/domains/leasing-sms";

describe("application fee facts for a prospect text", () => {
  it("quotes the resolved fee in dollars and the card total when a service fee is added", () => {
    expect(applicationFeeFactsForSms({ applicationFeeCents: 4500, feeSource: "listing" }, { serviceFeeCents: 175, totalCents: 4675, feePayer: "resident" })).toEqual({
      amount: "$45", free: false, source: "listing", cardServiceFee: "$1.75", cardTotal: "$46.75",
    });
  });

  it("says free for a zero fee and never invents a card total", () => {
    expect(applicationFeeFactsForSms({ applicationFeeCents: 0, feeSource: "account" }, { serviceFeeCents: 0, totalCents: 0, feePayer: "manager" })).toEqual({
      amount: "$0", free: true, source: "account", cardServiceFee: null, cardTotal: null,
    });
  });

  it("omits the card breakdown when the itemization could not be read", () => {
    expect(applicationFeeFactsForSms({ applicationFeeCents: 3500, feeSource: "room_term" }, null)).toMatchObject({ amount: "$35", cardTotal: null });
  });
});
