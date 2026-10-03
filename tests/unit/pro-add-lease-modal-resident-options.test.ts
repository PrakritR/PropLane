/**
 * C271 (U077): the lease wizard's Resident dropdown only ever lists approved
 * applicants (`buildApprovedResidentOptions` filters to bucket "approved"),
 * but nothing in the option's plain-text label said so, so a manager had to
 * already know who was approved to tell those rows apart from "New resident…".
 */
import { describe, expect, it } from "vitest";
import { approvedResidentOptionLabel } from "@/lib/lease-send-terms";

describe("approvedResidentOptionLabel (C271)", () => {
  it("flags an approved applicant with a room", () => {
    expect(approvedResidentOptionLabel({ residentName: "Cv Ponce", roomLabel: "Room 2" })).toBe(
      "Cv Ponce · Room 2 · Approved",
    );
  });

  it("still flags an approved applicant with no room (whole-home listing)", () => {
    expect(approvedResidentOptionLabel({ residentName: "Maya Chen", roomLabel: "" })).toBe("Maya Chen · Approved");
  });
});
