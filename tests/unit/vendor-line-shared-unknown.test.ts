// Shared mode: an unknown number asking for work goes to the jobs flow (jobs + sign-up link + lead), not the intake
// questions or the lead queue; a vendor describing themselves still gets the intake.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { leadFakeDb, LEAD_CONSTRAINTS } from "../helpers/lead-fake-db";

const lead = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ leadId: "lead-1" as string | null, reply: "LEAD: budget?" as string | null, assignedWorkspaceId: null as string | null })));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/rate-limit", () => ({ rateLimit: vi.fn(async () => ({ ok: true })), clientIpFrom: () => "1.1.1.1" }));
vi.mock("@/lib/test-workspaces/index.server", () => ({ resolveTestWorkspaceClassification: vi.fn(), lookupRecordTestWorkspaceId: vi.fn(async () => null) }));
// Only the lead hand-off is stubbed: the turn now also asks this module whether the text names a home and
// whether a lead is already open, and those read the fake db, so they stay real (a factory mock that omits
// them makes the module throw).
vi.mock("@/lib/one-number/unassigned-leads.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/one-number/unassigned-leads.server")>()),
  handleUnassignedLeadInbound: lead,
}));
vi.mock("@/lib/service/service-catalog.server", () => ({
  readPlatformServiceOwnerId: vi.fn(async () => "svc-owner"),
  isPropLaneServiceLine: vi.fn(async () => false),
}));
vi.mock("@/lib/open-jobs-near.server", () => ({
  listOpenJobsNear: vi.fn(async () => ({
    jobs: [{ title: "Sink", trade: "Plumbing", area: "Ravenna, Roosevelt and Wedgwood", when: "Anytime", budget: "Up to $250", distanceMiles: null }],
    total: 1, place: null, filteredByArea: false,
  })),
  titleWithoutAddress: (t: string) => t,
}));

import { handleUnknownSenderInbound } from "@/lib/one-number/onboarding/unknown-sender.server";
import { VENDOR_COPY } from "@/lib/one-number/onboarding/vendor-intake";

const PHONE = "2065550142";
const NOW = new Date("2026-10-19T20:00:00Z");
let sid = 0;
const text = (body: string) => ({ fromPhone: "+12065550142", phoneKey: PHONE, body, messageSid: `SM${++sid}`, mediaCount: 0 });
const deps = { now: () => NOW, origin: "https://proplane.ai" };

beforeEach(() => {
  lead.mockClear();
  sid = 0;
});

describe("an unknown number asking for work on the shared PropLane line", () => {
  it("gets the jobs and a sign-up link, is a pending lead, and is never sent to the lead queue", async () => {
    const f = leadFakeDb({}, { constraints: LEAD_CONSTRAINTS });
    const turn = await handleUnknownSenderInbound(f.db, text("hey is there any available jobs in the area to do"), deps);
    expect(lead).not.toHaveBeenCalled();
    expect(turn.reply).toContain("Hi, this is PropLane. Reply STOP to opt out.");
    expect(turn.reply).toContain("1. Plumbing, Ravenna, Roosevelt and Wedgwood, Up to $250");
    expect(turn.reply).toContain("https://proplane.ai/start/");
    expect(turn.reply).not.toContain(VENDOR_COPY.trade);
    expect(f.rows.sms_vendor_leads).toHaveLength(1);
    expect(f.rows.sms_vendor_leads![0]).toMatchObject({ phone_key: PHONE, status: "pending" });
    expect(f.rows.sms_onboarding_state![0]).toMatchObject({ role: "vendor" });
    expect(f.rows.manager_vendor_records ?? []).toEqual([]);
  });

  it("stays in the jobs flow on the next text", async () => {
    const f = leadFakeDb({}, { constraints: LEAD_CONSTRAINTS });
    await handleUnknownSenderInbound(f.db, text("any jobs available"), deps);
    const next = await handleUnknownSenderInbound(f.db, text("I do plumbing"), deps);
    expect(next.reply).toContain("1. Plumbing");
    expect(next.reply).not.toContain(VENDOR_COPY.rates);
    expect(f.rows.sms_vendor_leads).toHaveLength(1);
  });

  it("a vendor describing themselves still gets the intake questions", async () => {
    const f = leadFakeDb({}, { constraints: LEAD_CONSTRAINTS });
    const turn = await handleUnknownSenderInbound(f.db, text("I do cleaning in Seattle"), deps);
    expect(turn.reply).toBe(`${VENDOR_COPY.welcome} ${VENDOR_COPY.rates}`);
  });
});
