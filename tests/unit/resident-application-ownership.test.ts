import { describe, expect, it } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { residentOwnsApplicationRow } from "@/lib/rental-application/resident-application-ownership";

function row(over: Partial<DemoApplicantRow> = {}): DemoApplicantRow {
  return {
    id: "AXIS-TEST1",
    name: "Jamie",
    email: "jamie@example.com",
    property: "Test",
    stage: "Submitted",
    bucket: "pending",
    detail: "",
    ...over,
  };
}

describe("residentOwnsApplicationRow", () => {
  it("denies rows that match email with no residentUserId", () => {
    expect(residentOwnsApplicationRow(row(), { email: "jamie@example.com", userId: "user-1" })).toBe(false);
  });

  it("allows rows linked to the same resident user id", () => {
    expect(
      residentOwnsApplicationRow(row({ residentUserId: "user-1" }), {
        email: "jamie@example.com",
        userId: "user-1",
      }),
    ).toBe(true);
  });

  it("denies rows linked to a different resident user id", () => {
    expect(
      residentOwnsApplicationRow(row({ residentUserId: "other-user" }), {
        email: "jamie@example.com",
        userId: "user-1",
      }),
    ).toBe(false);
  });

  it("denies legacy email-only rows even when addresses normalize to the same mailbox", () => {
    expect(
      residentOwnsApplicationRow(
        row({ email: "resident@test.axis.local" }),
        { email: "resident@test.proplane.local", userId: "user-1" },
      ),
    ).toBe(false);
  });

  it("denies rows with a different email", () => {
    expect(residentOwnsApplicationRow(row(), { email: "other@example.com", userId: "user-1" })).toBe(false);
  });
});
