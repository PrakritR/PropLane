// @vitest-environment jsdom
//
// The manager's Applications list is one white card per application in the
// Properties shape — the name as the title, property · room as the address,
// a line of glyph facts (date, screening, household), ⋯ on every row — with a
// household's members kept together and a co-signer as its own row. No pills:
// the tab says the bucket (PLAN-0920-0436 → "No pills on rows, anywhere").
import { afterEach, describe, expect, it } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ManagerApplicationsGroupedTable } from "@/components/portal/pro-applications-grouped-table";
import { RecordActionContext } from "@/components/ui/record-action-context";
import { applicationStageFact, applicationSubmittedShort } from "@/lib/manager-application-list";
import type { DemoApplicantRow } from "@/data/demo-portal";
import type { ApplicationListCluster } from "@/lib/rental-application/application-list-grouping";
import type { CosignerSubmission } from "@/lib/cosigner-submissions-storage";

afterEach(() => cleanup());

const row = (over: Partial<DemoApplicantRow>): DemoApplicantRow =>
  ({
    id: "AXIS-1",
    name: "Ethan Wright",
    email: "ethan.wright@example.com",
    property: "Alder Row — 3 rooms",
    stage: "Pending review",
    bucket: "pending",
    detail: "Submitted 2026-09-11",
    assignedRoomChoice: "Room 2",
    application: { submittedAt: "2026-09-11T10:00:00Z" } as never,
    backgroundCheckStatus: "pending_review",
    ...over,
  }) as DemoApplicantRow;

const single = (r: DemoApplicantRow): ApplicationListCluster => ({ kind: "single", row: r });

function mount(clusters: ApplicationListCluster[], opts: { cosigners?: Map<string, CosignerSubmission[]>; actions?: React.ReactNode; onOpen?: (r: DemoApplicantRow) => void; onOpenCosigner?: (r: DemoApplicantRow, i: number) => void } = {}) {
  const table = (
    <ManagerApplicationsGroupedTable
      clusters={clusters}
      cosignerSubmissionsBySigner={opts.cosigners ?? new Map()}
      selectable
      selectedIds={new Set()}
      onToggleSelected={() => {}}
      onOpenApplication={opts.onOpen ?? (() => {})}
      onOpenCosigner={opts.onOpenCosigner ?? (() => {})}
    />
  );
  return render(
    opts.actions ? (
      <RecordActionContext.Provider value={{ actions: opts.actions, clear: () => {}, scope: "test" }}>{table}</RecordActionContext.Provider>
    ) : (
      table
    ),
  );
}

/** The one card on screen, with its facts line. */
function card() {
  const el = document.querySelector('[data-attr="application-list-row"]');
  expect(el).not.toBeNull();
  return el!;
}

/** Every pill shape a row could sneak back in: a rounded chip or the old status slot. */
function expectNoPills(scope: Element) {
  expect(scope.querySelector('[data-attr="application-row-status"]')).toBeNull();
  expect(scope.querySelector(".rounded-full")).toBeNull();
}

describe("an application is a Properties-style card", () => {
  it("names the applicant as the title, the home and room as the address, and puts the date in the facts line — no status pill", () => {
    mount([single(row({}))]);
    const el = card();
    expect(el.textContent).toContain("Ethan Wright");
    expect(el.textContent).toContain("Alder Row — 3 rooms");
    expect(el.querySelector('[data-attr="record-row-facts"]')!.textContent).toContain("Submitted Sep 11");
    // The tab says Pending; the row does not repeat it, and a pending
    // screening is silent.
    expect(el.textContent).not.toContain("Pending");
    expect(el.textContent).not.toContain("Screening pending");
    expectNoPills(document.body);
    // The old grey cluster box and nested row are gone.
    expect(document.querySelector('[data-attr="application-household-cluster"]')).toBeNull();
    expect(document.querySelector("table")).toBeNull();
  });

  it("says only what adds to the tab: an existing resident, a placement, a withdrawal — never Approved, Active, Pending or Rejected", () => {
    expect(applicationStageFact(row({ bucket: "approved", stage: "Existing resident" }))).toBe("Existing resident");
    expect(applicationStageFact(row({ bucket: "approved", stage: "Approved - placed" }))).toBe("Placed");
    expect(applicationStageFact(row({ bucket: "approved", stage: "Active" }))).toBeUndefined();
    expect(applicationStageFact(row({ bucket: "approved", stage: "Approved" }))).toBeUndefined();
    expect(applicationStageFact(row({ bucket: "rejected", stage: "Rejected" }))).toBeUndefined();
    expect(applicationStageFact(row({}))).toBeUndefined();
    expect(applicationStageFact(row({ withdrawnAt: "2026-09-12T00:00:00Z" }))).toBe("Withdrawn");
    expect(applicationStageFact(row({ bucket: "pending", stage: "In progress", detail: "Started 2026-09-12", application: { submittedAt: "" } as never }))).toBeUndefined();
    // The date is the calendar day the row states — never shifted by a timezone.
    expect(applicationSubmittedShort(row({}), new Date(2026, 8, 14))).toBe("Sep 11");
    expect(applicationSubmittedShort(row({ detail: "Submitted 2025-12-30" }), new Date(2026, 8, 14))).toBe("Dec 30, 2025");
    expect(applicationSubmittedShort(row({ detail: "Approved - placed", application: undefined }))).toBe("");
  });

  it("an approved existing resident carries that as a fact, and 'Added by you' never comes back", () => {
    mount([single(row({ bucket: "approved", stage: "Existing resident", manuallyAdded: true } as Partial<DemoApplicantRow>))]);
    const el = card();
    expect(el.querySelector('[data-attr="record-row-facts"]')!.textContent).toContain("Existing resident");
    expect(el.textContent).not.toContain("Added by you");
    expect(el.textContent).not.toContain("Approved");
    expectNoPills(document.body);
  });

  it("a screening that answered is a fact — flagged or passed", () => {
    mount([single(row({ backgroundCheckStatus: "flagged" } as Partial<DemoApplicantRow>))]);
    expect(card().querySelector('[data-attr="record-row-facts"]')!.textContent).toContain("Screening flagged");
    expectNoPills(document.body);
    cleanup();
    mount([single(row({ backgroundCheckStatus: "passed" } as Partial<DemoApplicantRow>))]);
    expect(card().querySelector('[data-attr="record-row-facts"]')!.textContent).toContain("Screening passed");
    expectNoPills(document.body);
  });

  it("opens the application from the row", () => {
    const opened: string[] = [];
    mount([single(row({}))], { onOpen: (r) => opened.push(r.id) });
    fireEvent.click(document.querySelector('[data-attr="application-list-row"]')!);
    expect(opened).toEqual(["AXIS-1"]);
  });

  it("keeps a household together with the group as a fact on each member", () => {
    const a = row({ id: "AXIS-1", name: "Olivia Brooks" });
    const b = row({ id: "AXIS-2", name: "Priya Shah", email: "priya@example.com" });
    mount([
      {
        kind: "household",
        groupId: "G1",
        group: { groupId: "G1", expectedSize: 3, members: [], submittedCount: 2, totalCount: 2, missingCount: 1, hasFirst: true, isOverSubscribed: false } as never,
        rows: [a, b],
      },
    ]);
    const cards = document.querySelectorAll('[data-attr="application-list-row"]');
    expect(cards.length).toBe(2);
    expect(cards[0]!.textContent).toContain("Olivia Brooks");
    expect(cards[1]!.textContent).toContain("Priya Shah");
    expect(screen.getAllByText(/Group 2\/3/).length).toBe(2);
    expectNoPills(document.body);
  });

  it("a household with no group code says how many sit together", () => {
    const a = row({ id: "AXIS-1", name: "Olivia Brooks" });
    const b = row({ id: "AXIS-2", name: "Priya Shah", email: "priya@example.com" });
    mount([{ kind: "household", groupId: "H1", group: null, rows: [a, b] } as never]);
    expect(screen.getAllByText(/Household of 2/).length).toBe(2);
    expectNoPills(document.body);
  });

  it("a co-signer is its own row under the applicant, no Signed pill, and opens the co-signer", () => {
    const opened: number[] = [];
    const cosigners = new Map<string, CosignerSubmission[]>([
      ["AXIS-1", [{ signerAppId: "AXIS-1", signerFullName: "Ethan Wright", fullName: "Casey Cosigner", email: "casey@example.com" } as CosignerSubmission]],
    ]);
    mount([single(row({}))], { cosigners, onOpenCosigner: (_r, i) => opened.push(i) });
    const cos = document.querySelector('[data-attr="application-cosigner-row"]')!;
    expect(cos).not.toBeNull();
    expect(cos.textContent).toContain("Casey Cosigner");
    expect(cos.textContent).toContain("Co-signer for Ethan Wright");
    expect(cos.textContent).not.toContain("Signed");
    expect(card().querySelector('[data-attr="record-row-facts"]')!.textContent).toContain("1 co-signer");
    expectNoPills(document.body);
    fireEvent.click(cos.querySelector('[data-attr="application-cosigner-list-row"]')!);
    expect(opened).toEqual([0]);
  });

  it("carries ⋯ on the row with that row's actions", () => {
    mount([single(row({}))], {
      actions: (
        <>
          <button type="button">Approve</button>
          <button type="button">Reject</button>
        </>
      ),
    });
    const more = screen.getByRole("button", { name: /Actions for Ethan Wright/ });
    expect(more).toBeTruthy();
  });
});
