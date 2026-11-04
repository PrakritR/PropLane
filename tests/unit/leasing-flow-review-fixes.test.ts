// Review fixes on the leasing-flow pass: each guard below was a production defect the first cut left open.
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { NextResponse } from "next/server";

vi.mock("server-only", () => ({}));

const access = vi.hoisted(() => ({ held: new Set<string>() }));
vi.mock("@/lib/auth/manager-application-access", () => ({
  createApplicationAccessMemo: () => ({}),
  managerCanAccessApplicationRecord: async (_db: unknown, _user: string, record: { id: string }) => access.held.has(record.id),
}));
vi.mock("@/lib/auth/delete-portal-account", () => ({ deleteResidentAccount: vi.fn() }));
vi.mock("@/lib/auth/find-auth-user-id-by-email", () => ({ findAuthUserIdByEmail: vi.fn() }));
vi.mock("@/lib/auth/resident-relationship", () => ({ managerOwnsResident: vi.fn(), residentPropertyIdsForManager: vi.fn() }));
vi.mock("@/lib/workspaces/scope.server", () => ({ activeWorkspacePropertyScope: vi.fn() }));

import { loadResidentApprovalDraftBlock } from "@/lib/resident-approval.server";
import { ackWithinBudget } from "@/lib/sms/inbound-ack.server";
import { TOUR_STEP_FIELD_ORDER } from "@/lib/wizard-field-errors";
import { pacificHourOfDay } from "@/lib/pacific-time";
import { pacificHour } from "@/lib/one-number/morning-digest.server";

const read = (file: string) => readFileSync(join(process.cwd(), file), "utf8");

function dbWith(rows: Array<{ id: string; row_data: Record<string, unknown> }>, error = false) {
  const q: Record<string, unknown> = {
    select: () => q,
    eq: async () => (error ? { data: null, error: { message: "x" } } : { data: rows.map((r) => ({ manager_user_id: "m1", property_id: "p1", assigned_property_id: null, ...r })), error: null }),
  };
  return { from: () => q } as never;
}
const actor = { userId: "m1", isAdmin: false };

describe("set_resident_approval refuses an applicant whose only application is an unsent draft", () => {
  it("blocks on an explicit draft stage and on a stage-less legacy wizard row", async () => {
    access.held = new Set(["a"]);
    await expect(loadResidentApprovalDraftBlock(dbWith([{ id: "a", row_data: { bucket: "pending", stage: "In progress" } }]), actor, "k@x.co")).resolves.toEqual({ blocked: true, readFailed: false });
    await expect(
      loadResidentApprovalDraftBlock(dbWith([{ id: "a", row_data: { bucket: "pending", application: { fullLegalName: "K" } } }]), actor, "k@x.co"),
    ).resolves.toMatchObject({ blocked: true });
  });

  it("lets a submitted, approved or hand-added row through, and never reads an approved row as a draft", async () => {
    access.held = new Set(["a", "b"]);
    const draft = { id: "a", row_data: { bucket: "pending", stage: "In progress" } };
    for (const other of [
      { bucket: "pending", stage: "Submitted" },
      { bucket: "approved", stage: "Approved", application: { fullLegalName: "K" } },
      { bucket: "approved", application: { fullLegalName: "K" } },
      { bucket: "pending", manuallyAdded: true, application: { fullLegalName: "K" } },
    ]) {
      await expect(loadResidentApprovalDraftBlock(dbWith([draft, { id: "b", row_data: other }]), actor, "k@x.co")).resolves.toMatchObject({ blocked: false });
    }
  });

  it("ignores rows the caller does not hold, and fails closed (readFailed) on an unreadable list", async () => {
    access.held = new Set();
    await expect(loadResidentApprovalDraftBlock(dbWith([{ id: "a", row_data: { bucket: "pending", stage: "In progress" } }]), actor, "k@x.co")).resolves.toMatchObject({ blocked: false });
    await expect(loadResidentApprovalDraftBlock(dbWith([], true), actor, "k@x.co")).resolves.toEqual({ blocked: false, readFailed: true });
  });

  it("the tool preview and the shared setter both run the guard, only when approving", () => {
    expect(read("src/lib/tools/domains/residents.ts")).toContain("loadResidentApprovalDraftBlock");
    const lib = read("src/lib/resident-approval.server.ts");
    expect(lib).toMatch(/if \(input\.approved\) \{\s*const draft = await loadResidentApprovalDraftBlock/);
  });
});

describe("resident-approval route refuses an unsent draft on BOTH the id and the email match", () => {
  it("has no id-only exemption", () => {
    const route = read("src/app/api/portal/resident-approval/route.ts");
    expect(route).toContain("if (isUnsubmittedDraftApplicationRow(lookup.stored))");
    expect(route).not.toContain('lookup.matchedBy === "id" && isUnsubmittedDraftApplicationRow');
  });
});

describe("Twilio inbound only acks early once the receipt is claimed", () => {
  const twiml = (m: string) => new NextResponse(`<Response>${m}</Response>`, { status: 200 });
  const base = (canAck: () => boolean) => {
    const scheduled: Array<() => Promise<void>> = [];
    return { scheduled, opts: { budgetMs: 10, canAck, ack: () => twiml(""), schedule: (t: () => Promise<void>) => { scheduled.push(t); }, sendLate: vi.fn(async () => undefined) } };
  };

  it("a pre-claim 5xx past the budget is returned to Twilio, not swallowed by a 200", async () => {
    const h = base(() => false);
    const slowFail = new Promise<NextResponse>((r) => setTimeout(() => r(NextResponse.json({ error: "Inbound receipt unavailable." }, { status: 503 })), 80));
    const res = await ackWithinBudget(slowFail, h.opts);
    expect(res.status).toBe(503);
    expect(h.scheduled).toHaveLength(0);
  });

  it("acks with 200 as soon as the claim lands after the budget", async () => {
    let claimed = false;
    const h = base(() => claimed);
    const slow = new Promise<NextResponse>((r) => setTimeout(() => r(twiml("<Message>Late</Message>")), 400));
    setTimeout(() => { claimed = true; }, 40);
    const res = await ackWithinBudget(slow, h.opts);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain("<Message");
    expect(h.scheduled).toHaveLength(1);
  });

  it("the route marks the claim and passes canAck", () => {
    const route = read("src/app/api/twilio/inbound/route.ts");
    expect(route).toContain("canAck: () => late.claimed");
    expect(route.indexOf("late.claimed = true")).toBeGreaterThan(route.indexOf('mark("claimed")'));
  });
});

describe("lease terms drift reads the application under the lease's workspace owner", () => {
  const route = read("src/app/api/portal-lease-pipeline/route.ts");
  it("resolves the owner, matches id variants, and refuses (409 terms-unreadable) when the record cannot be read", () => {
    expect(route).toContain("resolveLeaseTermsOwner(");
    expect(route).toContain('.in("id", idVariants(termsAxisId))');
    expect(route).toContain(".eq(\"manager_user_id\", termsOwner)");
    expect(route).toContain("if (!appRow) return termsUnreadable;");
    expect(route).toContain("if (!termsOwner) return termsUnreadable;");
    expect(route).not.toContain('.eq("manager_user_id", existingRecord?.manager_user_id ?? ctx.user.id)\n          .maybeSingle()');
  });
});

describe("check-in digest", () => {
  const src = read("src/lib/one-number/checkin-digest.server.ts");
  it("reads each house's clock from the property row it already loaded, not per house", () => {
    expect(src).not.toContain("loadPropertyStayClock");
    expect(src).toContain("propertyStayClockFromRecord");
  });
  it("shares one Pacific-hour helper with the morning digest", () => {
    expect(src).not.toMatch(/function pacificHourOf\b/);
    expect(pacificHour).toBe(pacificHourOfDay);
    expect(pacificHourOfDay(new Date("2026-11-03T15:30:00Z"))).toBe(7);
    expect(pacificHourOfDay(new Date("2026-07-03T14:30:00Z"))).toBe(7);
  });
});

describe("application_started alert is awaited, not detached", () => {
  it("has no fire-and-forget promise around the ops alert", () => {
    const src = read("src/lib/rental-application/signed-in-application-write.server.ts");
    expect(src).not.toContain("void (async () => {");
    expect(src).toMatch(/try \{\s*const \{ alertPhonesOf \}[\s\S]*await alertPhonesOf/);
  });
});

describe("draft dedupe lookup is newest first before the limit", () => {
  it("orders by updated_at desc ahead of limit(50)", () => {
    const src = read("src/lib/rental-application/application-draft-dedupe.server.ts");
    expect(src).toMatch(/\.order\("updated_at", \{ ascending: false[^)]*\}\)\.limit\(50\)/);
  });
});

describe("tour flow", () => {
  it("TOUR_STEP_FIELD_ORDER has the two steps the flow numbers", () => {
    expect(Object.keys(TOUR_STEP_FIELD_ORDER)).toEqual(["1", "2"]);
    expect(TOUR_STEP_FIELD_ORDER[1]).toEqual(["property", "room", "tourSlot"]);
    expect(TOUR_STEP_FIELD_ORDER[2]).toEqual(["name", "email", "phone"]);
  });
  it("uses only indices 1 and 2 and goes back to the account step on a 401", () => {
    const flow = read("src/components/marketing/tour-schedule-flow.tsx");
    expect(flow).not.toMatch(/TOUR_STEP_FIELD_ORDER\[3\]/);
    expect(flow).toContain("if (result.status === 401) setSessionExpired(true);");
    expect(flow).toContain("if (failedResult.status === 401) setSessionExpired(true);");
    expect(flow).toContain('const signedInUserId = sessionExpired ? "" : contactAutofill.userId;');
  });
});
