/**
 * N080: Bookings' lease bars, the Payments charges list, Services'
 * work-order/service-request lists, and dashboard KPIs each read their own
 * table directly with no resident-linkage check — so a row a completed
 * resident delete (or a bug) left behind kept rendering forever on every
 * OTHER surface even after the person was gone from Residents. This is the
 * shared predicate the display-side backstop is built on.
 */
import { describe, expect, it } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { directoryResidentEmailSet, isLinkedToDirectoryResident } from "@/lib/resident-directory-scope";

function application(over: Partial<DemoApplicantRow> & Pick<DemoApplicantRow, "id">): DemoApplicantRow {
  return {
    name: "Resident Example",
    property: "Prop One",
    stage: "Approved",
    bucket: "approved",
    detail: "",
    email: "resident@example.com",
    ...over,
  } as DemoApplicantRow;
}

describe("directoryResidentEmailSet / isLinkedToDirectoryResident (N080)", () => {
  it("links an email with a Current (approved) application row", () => {
    const emails = directoryResidentEmailSet([application({ id: "a1", email: "current@example.com" })]);
    expect(isLinkedToDirectoryResident("current@example.com", emails)).toBe(true);
    expect(isLinkedToDirectoryResident("Current@Example.com", emails)).toBe(true);
  });

  it("links an email with a Potential (pending) application row", () => {
    const emails = directoryResidentEmailSet([
      application({ id: "a1", email: "potential@example.com", bucket: "pending", stage: "Submitted" }),
    ]);
    expect(isLinkedToDirectoryResident("potential@example.com", emails)).toBe(true);
  });

  it("links an email with a Past (moved-out approved) application row", () => {
    const emails = directoryResidentEmailSet([
      application({ id: "a1", email: "past@example.com", stage: "Moved out" }),
    ]);
    expect(isLinkedToDirectoryResident("past@example.com", emails)).toBe(true);
  });

  it("links a rejected or withdrawn applicant's email — the application row still exists", () => {
    const emails = directoryResidentEmailSet([
      application({ id: "a1", email: "rejected@example.com", bucket: "rejected", stage: "Rejected" }),
      application({ id: "a2", email: "withdrawn@example.com", bucket: "pending", withdrawnAt: "2026-01-01" }),
    ]);
    expect(isLinkedToDirectoryResident("rejected@example.com", emails)).toBe(true);
    expect(isLinkedToDirectoryResident("withdrawn@example.com", emails)).toBe(true);
  });

  it("does not link an email with no application row at all — the person was deleted", () => {
    const emails = directoryResidentEmailSet([application({ id: "a1", email: "someone-else@example.com" })]);
    expect(isLinkedToDirectoryResident("deleted@example.com", emails)).toBe(false);
  });

  it("treats a blank or missing email as not linked", () => {
    const emails = directoryResidentEmailSet([application({ id: "a1" })]);
    expect(isLinkedToDirectoryResident("", emails)).toBe(false);
    expect(isLinkedToDirectoryResident(undefined, emails)).toBe(false);
    expect(isLinkedToDirectoryResident(null, emails)).toBe(false);
  });

  it("always treats a channel-import placeholder as linked — it was never a directory resident", () => {
    const emails = directoryResidentEmailSet([]);
    expect(isLinkedToDirectoryResident("stay-42@import.proplane.local", emails)).toBe(true);
  });
});
