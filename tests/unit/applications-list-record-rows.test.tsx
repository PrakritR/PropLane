// @vitest-environment jsdom
//
// The manager's Applications list is one white card per application in the
// Properties shape — the name as the title, property · room as the address,
// the date in bold and a status chip on the right, ⋯ on every row — with a
// household's members kept together and a co-signer as its own row.
import { afterEach, describe, expect, it } from "vitest";
import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ManagerApplicationsGroupedTable } from "@/components/portal/pro-applications-grouped-table";
import { RecordActionContext } from "@/components/ui/record-action-context";
import { applicationStatusChip, applicationSubmittedShort } from "@/lib/manager-application-list";
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

describe("an application is a Properties-style card", () => {
  it("names the applicant as the title, the home and room as the address, and puts the date and status on the right", () => {
    mount([single(row({}))]);
    const card = document.querySelector('[data-attr="application-list-row"]')!;
    expect(card).not.toBeNull();
    expect(card.textContent).toContain("Ethan Wright");
    expect(card.textContent).toContain("Alder Row — 3 rooms");
    expect(card.textContent).toContain("Submitted Sep 11");
    expect(document.querySelector('[data-attr="application-row-status"]')!.textContent).toBe("Pending");
    expect(card.textContent).toContain("Screening pending");
    // The old grey cluster box and nested row are gone.
    expect(document.querySelector('[data-attr="application-household-cluster"]')).toBeNull();
    expect(document.querySelector("table")).toBeNull();
  });

  it("says Approved · placed, Rejected and Incomplete on their rows", () => {
    expect(applicationStatusChip(row({ bucket: "approved", stage: "Approved - placed" }))).toEqual({ label: "Approved · placed", tone: "ok" });
    expect(applicationStatusChip(row({ bucket: "rejected", stage: "Rejected" }))).toEqual({ label: "Rejected", tone: "neutral" });
    expect(applicationStatusChip(row({ bucket: "pending", stage: "In progress", detail: "Started 2026-09-12", application: { submittedAt: "" } as never }))).toEqual({ label: "Incomplete", tone: "neutral" });
    // The date is the calendar day the row states — never shifted by a timezone.
    expect(applicationSubmittedShort(row({}), new Date(2026, 8, 14))).toBe("Sep 11");
    expect(applicationSubmittedShort(row({ detail: "Submitted 2025-12-30" }), new Date(2026, 8, 14))).toBe("Dec 30, 2025");
    expect(applicationSubmittedShort(row({ detail: "Approved - placed", application: undefined }))).toBe("");
  });

  it("opens the application from the row", () => {
    const opened: string[] = [];
    mount([single(row({}))], { onOpen: (r) => opened.push(r.id) });
    fireEvent.click(document.querySelector('[data-attr="application-list-row"]')!);
    expect(opened).toEqual(["AXIS-1"]);
  });

  it("keeps a household together with a Group chip on each member", () => {
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
  });

  it("a co-signer is its own row under the applicant and opens the co-signer", () => {
    const opened: number[] = [];
    const cosigners = new Map<string, CosignerSubmission[]>([
      ["AXIS-1", [{ signerAppId: "AXIS-1", signerFullName: "Ethan Wright", fullName: "Casey Cosigner", email: "casey@example.com" } as CosignerSubmission]],
    ]);
    mount([single(row({}))], { cosigners, onOpenCosigner: (_r, i) => opened.push(i) });
    const cos = document.querySelector('[data-attr="application-cosigner-row"]')!;
    expect(cos).not.toBeNull();
    expect(cos.textContent).toContain("Casey Cosigner");
    expect(cos.textContent).toContain("Co-signer for Ethan Wright");
    expect(document.querySelector('[data-attr="application-list-row"]')!.textContent).toContain("1 co-signer");
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
