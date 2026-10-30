import { describe, expect, it } from "vitest";
import { applicationFeeCentsFromPropertyData } from "@/lib/application-fee-server";
import { publicAdminSchedulingHostLabel, publicSchedulingHostLabel } from "@/lib/public-host-label";

describe("public host labels", () => {
  it("uses first name and never exposes email", () => {
    expect(publicSchedulingHostLabel({ email: "alex@example.com", fullName: "Alex Morgan" })).toBe("Alex");
    expect(publicSchedulingHostLabel({ email: "alex@example.com" })).toBe("Property manager");
  });

  it("labels admin hosts without email", () => {
    expect(publicAdminSchedulingHostLabel({ email: "admin@axis.com", fullName: "Sam Lee" })).toBe("Sam");
    expect(publicAdminSchedulingHostLabel({ email: "admin@axis.com" })).toBe("PropLane team member");
  });
});

describe("applicationFeeCentsFromPropertyData", () => {
  it("parses listing application fee", () => {
    expect(
      applicationFeeCentsFromPropertyData({
        listingSubmission: { v: 1, applicationFee: "75.50" },
      }),
    ).toBe(7550);
  });

  it("is free when submission missing", () => {
    expect(applicationFeeCentsFromPropertyData(null)).toBe(0);
  });
});
