/**
 * The manager resident record's tab headers: which icon actions each tab / sub-tab shows (captain,
 * 2026-10-06). Absent, never disabled; no ⋯. This is the table the studio plan approved.
 */
import { describe, expect, it } from "vitest";
import { recordSections } from "@/lib/portals/record-sections";
import {
  residentSectionHeaderActions,
  type ResidentSectionActionContext,
} from "@/lib/resident-record-section-actions";

const base = (tab: string): ResidentSectionActionContext => ({
  tab,
  registry: recordSections("manager", "resident", { basePath: "/portal" }, tab).headerActions,
  application: {
    present: true,
    rowBucket: "pending",
    subTab: "pending",
    hasForm: true,
    undecidable: false,
    remindable: false,
    screening: false,
    checkStatus: undefined,
    hasCheck: false,
  },
  lease: { present: true, subTab: "draft" },
  payments: { bucket: "pending", rowsInBucket: 2 },
  tourBucket: "pending",
});
const ids = (ctx: ResidentSectionActionContext) => residentSectionHeaderActions(ctx).map((a) => a.id);
const app = (patch: Partial<ResidentSectionActionContext["application"]>) => {
  const ctx = base("application");
  return { ...ctx, application: { ...ctx.application, ...patch } };
};

describe("Application", () => {
  it("Incomplete: Remind, Edit, Send application", () => {
    expect(ids(app({ rowBucket: "incomplete", subTab: "incomplete", remindable: true }))).toEqual(["remind-application", "edit", "send-application"]);
  });
  it("Pending: Reject, Edit, Download, Approve and no bell", () => {
    expect(ids(app({}))).toEqual(["decline", "edit", "download", "approve"]);
  });
  it("Pending but withdrawn: nothing to decide", () => {
    expect(ids(app({ undecidable: true }))).toEqual(["edit", "download"]);
  });
  it("Approved: Download, Send lease", () => {
    expect(ids(app({ rowBucket: "approved", subTab: "approved" }))).toEqual(["download", "send-lease"]);
  });
  it("Rejected: Download", () => {
    expect(ids(app({ rowBucket: "rejected", subTab: "rejected" }))).toEqual(["download"]);
  });
  it("a sub-tab the application is not under has nothing to act on", () => {
    expect(ids(app({ subTab: "approved" }))).toEqual([]);
    expect(ids(app({ present: false, rowBucket: null }))).toEqual([]);
  });
});

describe("Lease", () => {
  const lease = (subTab: ResidentSectionActionContext["lease"]["subTab"], present = true) => ({ ...base("lease"), lease: { present, subTab } });
  it("Draft: Edit, Send", () => expect(ids(lease("draft"))).toEqual(["edit-lease", "send-lease"]));
  it("Resident signature: Remind", () => expect(ids(lease("resident"))).toEqual(["remind-sign"]));
  it("Manager signature: Sign", () => expect(ids(lease("manager"))).toEqual(["sign-lease"]));
  it("Signed: Download", () => expect(ids(lease("completed"))).toEqual(["download"]));
  it("no lease in the sub-tab: nothing", () => expect(ids(lease("draft", false))).toEqual([]));
});

describe("Payments", () => {
  const pay = (bucket: "overdue" | "pending" | "paid", rowsInBucket: number) => ({ ...base("payments"), payments: { bucket, rowsInBucket } });
  it("Pending and Overdue: Remind and the +", () => {
    expect(ids(pay("pending", 2))).toEqual(["remind-payment", "add-charge"]);
    expect(ids(pay("overdue", 1))).toEqual(["remind-payment", "add-charge"]);
  });
  it("an empty Pending tab has nobody to remind but still adds a charge", () => {
    expect(ids(pay("pending", 0))).toEqual(["add-charge"]);
  });
  it("Paid: Download", () => {
    expect(ids(pay("paid", 3))).toEqual(["download"]);
    expect(ids(pay("paid", 0))).toEqual([]);
  });
});

describe("Background check, Tours and the rest", () => {
  it("Run check, then Run new check once a check exists, nothing while one is pending", () => {
    expect(ids(base("background-check"))).toEqual(["run-check"]);
    const done = { ...base("background-check"), application: { ...base("background-check").application, hasCheck: true, checkStatus: "complete" } };
    expect(residentSectionHeaderActions(done).map((a) => a.label)).toEqual(["Run new check"]);
    const pending = { ...base("background-check"), application: { ...base("background-check").application, hasCheck: true, checkStatus: "pending" } };
    expect(ids(pending)).toEqual([]);
  });
  it("Tours: the + on Scheduled and Upcoming, nothing on Past", () => {
    expect(ids({ ...base("tours"), tourBucket: "pending" })).toEqual(["add-tour"]);
    expect(ids({ ...base("tours"), tourBucket: "upcoming" })).toEqual(["add-tour"]);
    expect(ids({ ...base("tours"), tourBucket: "past" })).toEqual([]);
  });
  it("Documents keeps its +, Overview has no header card", () => {
    expect(ids(base("documents"))).toEqual(["upload"]);
    expect(ids(base("overview"))).toEqual([]);
  });
  it("no tab ever lists a ⋯ or a disabled action", () => {
    for (const tab of ["application", "lease", "payments", "background-check", "tours", "documents", "services"]) {
      for (const action of residentSectionHeaderActions(base(tab))) expect(action.id).not.toMatch(/more|overflow/);
    }
  });
});
