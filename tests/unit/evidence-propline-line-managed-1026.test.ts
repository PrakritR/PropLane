/**
 * The PropLane line (206), Oct 26 — written out as a readable transcript instead of only asserted.
 *
 * Two facts a reviewer cannot see on any screen:
 *
 *   A. WHICH NUMBER a text leaves from. Every PropLane-MANAGED workspace (`portal_workspaces.is_service`) sends on the
 *      PropLane line in BOTH line modes, even while it still holds a live number of its own; a self-serve workspace is
 *      untouched; and a line that cannot be resolved refuses the send rather than falling back to the old number.
 *   B. WHO may type DISPATCH on that line. A PropLane Service SEAT holder is recognized against the LINE OWNER's id, not
 *      a workspace they hold, so the keyword that texts a manager's whole vendor roster must not open a run for them.
 *
 *   EVIDENCE_DIR=<dir> npx vitest run tests/unit/evidence-propline-line-managed-1026.test.ts
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createMemoryDb } from "./support/memory-supabase";
import { fakeOwnerDb } from "../helpers/owner-fake-db";

/* ------------------------------------------------------------------ mocks: the line half */

vi.mock("@/lib/one-number/personal-number-entitlement.server", () => ({
  managerPersonalNumberEntitlement: vi.fn(async () => ({ ok: true as const, entitled: true as const, via: "plan" as const, tier: "pro" as const })),
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: vi.fn() }));
vi.mock("@/lib/comms-billing/eligibility.server", () => ({ evaluateManagerCommsBillingGate: vi.fn(async () => ({ allowed: true })) }));
vi.mock("@/lib/sms/number-registration-policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sms/number-registration-policy")>()),
  evaluateManagerSmsNumberSendability: vi.fn(() => ({ sendable: true })),
}));

/* ------------------------------------------------------------------ mocks: the dispatch half */

const s = vi.hoisted(() => ({ runCalls: [] as Array<{ id: string }>, workspaceByProperty: {} as Record<string, string> }));
vi.mock("@/lib/agent-notify.server", () => ({ notifyManagerFromAgent: async () => undefined }));
vi.mock("@/lib/vendor-dispatch/triggers.server", () => ({
  maybeCreateRuleRunForWorkOrder: async (_db: unknown, id: string) => {
    s.runCalls.push({ id });
    return "created";
  },
  resolveOwnerAndWorkspace: async (_db: unknown, input: { ownerUserId?: string; propertyId?: string | null }) => ({
    ownerUserId: input.ownerUserId ?? "mgr",
    workspaceId: s.workspaceByProperty[String(input.propertyId ?? "")] ?? "ws-1",
  }),
}));
vi.mock("@/lib/tools/domains/work-orders", () => ({ loadVendorsForMatching: async () => [], loadManagerWorkOrders: async () => [] }));
vi.mock("@/lib/agent/vendor-agent.server", () => ({ ensureVendorAgentSession: async () => undefined }));
vi.mock("@/lib/google-calendar/sync.server", () => ({ syncWorkOrderToGoogleCalendar: async (_d: unknown, _o: unknown, row: unknown) => row }));

import { handleManagerDispatchReply } from "@/lib/vendor-dispatch/inbound.server";
import { resolveActiveManagerSendNumber } from "@/lib/sms/manager-number-provisioning.server";
import { evaluateWorkspaceSendReadiness } from "@/lib/sms/workspace-send-readiness.server";
import { resetDispatchSettingsCache } from "@/lib/vendor-dispatch/service-default.server";
import { WORKSPACE_NO_WORK_NUMBER_CODE } from "@/lib/sms/workspace-no-work-number";

/* ------------------------------------------------------------------ transcript */

const transcript: string[] = [];
const say = (line = "") => transcript.push(line);
const scene = (title: string) => {
  say();
  say(title);
  say("-".repeat(title.length));
};

afterAll(() => {
  const dir = process.env.EVIDENCE_DIR;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "propline-line-managed-transcript.txt"), `${transcript.join("\n")}\n`);
});

/* ------------------------------------------------------------------ world */

const SVC_OWNER = "00000000-0000-4000-8000-0000000000a0";
const AMBIKA = "00000000-0000-4000-8000-0000000000a1";
const SELF = "00000000-0000-4000-8000-0000000000a2";
const LINE_206 = "+12066781909";
const AMBIKA_OWN = "+18146793694";
const SELF_OWN = "+15025550142";

const numberRow = (over: Record<string, unknown>) => ({
  phone_number_sid: "PN1", messaging_service_sid: "MGdefault", campaign_sid: "CP1", provision_state: "active", registration_state: "approved",
  registration_ref: null, attachment_state: "attached", number_registration_state: "registered", released_at: null,
  grace_started_at: null, grace_expires_at: null, quarantined_at: null, quarantine_reason: null, ...over,
});

function world(mode: "shared" | "per_workspace", over: { releasedLine?: boolean } = {}) {
  return createMemoryDb({
    sms_runtime_config: [{
      singleton: true, mode: "automatic", pilot_manager_user_ids: [],
      line_mode: mode, shared_number_e164: LINE_206, shared_messaging_service_sid: "MGshared", shared_pilot_workspace_ids: [],
    }],
    platform_service_settings: [{ singleton: true, owner_user_id: SVC_OWNER }],
    portal_workspaces: [
      { id: "ws-svc-home", name: "PropLane", owner_user_id: SVC_OWNER, is_default: true, is_service: false },
      { id: "ws-ambika", name: "Ambika Homes", owner_user_id: AMBIKA, is_default: true, is_service: true },
      { id: "ws-self", name: "Self Serve", owner_user_id: SELF, is_default: true, is_service: false },
    ],
    manager_sms_numbers: [
      numberRow({ id: "n-206", manager_user_id: SVC_OWNER, workspace_id: "ws-svc-home", phone_number: LINE_206, released_at: over.releasedLine ? "2026-10-01" : null }),
      numberRow({ id: "n-ambika", manager_user_id: AMBIKA, workspace_id: "ws-ambika", phone_number: AMBIKA_OWN }),
      numberRow({ id: "n-self", manager_user_id: SELF, workspace_id: "ws-self", phone_number: SELF_OWN }),
    ],
    workspace_work_numbers: [
      { workspace_id: "ws-ambika", number_id: "n-ambika", is_primary: true },
      { workspace_id: "ws-self", number_id: "n-self", is_primary: true },
    ],
    manager_property_records: [
      { id: "h-ambika", manager_user_id: AMBIKA, workspace_id: "ws-ambika" },
      { id: "h-self", manager_user_id: SELF, workspace_id: "ws-self" },
    ],
    profiles: [{ id: AMBIKA, email: "a@example.com" }],
    sms_manager_entitlements: [],
    account_link_invites: [],
  });
}

const sendsFrom = async (db: ReturnType<typeof world>, ownerUserId: string, over: Record<string, unknown>) =>
  evaluateWorkspaceSendReadiness({ db: db as never, ownerUserId, requiredCents: 3, ...over });

beforeEach(() => {
  resetDispatchSettingsCache();
  s.runCalls.length = 0;
  s.workspaceByProperty = {};
  process.env.TWILIO_MESSAGING_SERVICE_SID = "MGdefault";
  process.env.TWILIO_CAMPAIGN_SID = "CP1";
  process.env.SMS_PROVISIONING_ENABLED = "1";
});
afterEach(() => {
  delete process.env.SMS_PROVISIONING_ENABLED;
});

describe("which number a workspace's text leaves from", () => {
  it("a PropLane-managed workspace sends on the 206 in both modes; a self-serve one keeps its own; an unresolvable line refuses", async () => {
    scene("SCENE 1 — Ambika Homes is PropLane-managed and still holds its own number +1 814 679 3694");
    for (const mode of ["per_workspace", "shared"] as const) {
      const db = world(mode);
      const ready = await sendsFrom(db, AMBIKA, { workspaceId: "ws-ambika" });
      const from = ready.canSend ? ready.numberRow.phone_number : null;
      say(`  line_mode ${mode.padEnd(14)} text about Ambika Homes leaves from ${from}${ready.canSend && ready.viaSharedLine ? " (shared sender)" : ""}`);
      say(`  ${" ".repeat(25)}wallet charged: ${ready.canSend ? ready.workspaceId : "-"}`);
      expect(from).toBe(LINE_206);
      expect(await resolveActiveManagerSendNumber(db as never, AMBIKA, "ws-ambika")).toBe(LINE_206);
      // The workspace's own line is still readable where that is what is asked for.
      expect(await resolveActiveManagerSendNumber(db as never, AMBIKA, "ws-ambika", { ownLineOnly: true })).toBe(AMBIKA_OWN);
    }
    say(`  the workspace's own number is never used for a send, though it is still on file: ${AMBIKA_OWN}`);

    scene("SCENE 2 — however the message names the workspace, the answer is the same line");
    const db = world("per_workspace");
    for (const [label, hint] of [
      ["about one of its houses", { propertyId: "h-ambika" }],
      ["stamped on a queued message", { sharedLineWorkspaceId: "ws-ambika" }],
      ["pinned to the old line", { workLineId: "n-ambika" }],
      ["no hint at all", {}],
    ] as const) {
      const ready = await sendsFrom(db, AMBIKA, hint);
      say(`  ${label.padEnd(30)} → ${ready.canSend ? ready.numberRow.phone_number : `refused (${ready.reason})`}`);
      expect(ready.canSend && ready.numberRow.phone_number).toBe(LINE_206);
    }

    scene("SCENE 3 — a self-serve workspace is untouched");
    const self = await sendsFrom(world("per_workspace"), SELF, { workspaceId: "ws-self" });
    say(`  Self Serve → ${self.canSend ? self.numberRow.phone_number : `refused (${self.reason})`} (its own number)`);
    expect(self.canSend && self.numberRow.phone_number).toBe(SELF_OWN);

    scene("SCENE 4 — fail closed: the 206 is released, so there is no line to send on");
    const released = await sendsFrom(world("per_workspace", { releasedLine: true }), AMBIKA, { workspaceId: "ws-ambika" });
    say(`  Ambika Homes → refused (${released.canSend ? "sent" : released.reason}) — never the old ${AMBIKA_OWN}`);
    expect(released).toEqual({ canSend: false, reason: WORKSPACE_NO_WORK_NUMBER_CODE });
  });
});

describe("who may type DISPATCH on the PropLane line", () => {
  it("the workspace's own manager opens a run; a PropLane Service seat holder never does", async () => {
    const jobs = () =>
      fakeOwnerDb(
        {
          portal_work_order_records: [
            { id: "wo-1", manager_user_id: "mgr", updated_at: new Date().toISOString(), row_data: { id: "wo-1", title: "Leaking faucet", category: "plumbing", bucket: "open", propertyId: "p-1", propertyName: "Maple Court" } },
          ],
          portal_workspaces: [{ id: "ws-1", is_service: false }],
          manager_automation_settings: [],
          audit_log: [],
        },
        { uniques: { audit_log: [["dedupe_key"]] } },
      );

    scene("SCENE 5 — the manager of the workspace texts DISPATCH");
    s.workspaceByProperty = { "p-1": "ws-1" };
    const byManager = await handleManagerDispatchReply(jobs().db as never, { ownerUserId: "mgr", workspaceId: "ws-1", actorUserId: "mgr", body: "DISPATCH" });
    say(`  "DISPATCH" from the manager → handled: ${byManager.handled} · vendor runs opened: ${s.runCalls.map((c) => c.id).join(", ") || "none"}`);
    expect(byManager).toMatchObject({ handled: true });
    expect(s.runCalls).toEqual([{ id: "wo-1" }]);

    scene("SCENE 6 — a PropLane Service SEAT holder texts DISPATCH on the same line");
    s.runCalls.length = 0;
    const bySeat = await handleManagerDispatchReply(jobs().db as never, {
      ownerUserId: "mgr",
      workspaceId: "ws-1",
      actorUserId: "seat-viewer",
      body: "DISPATCH",
      // How the inbound pipeline marks a sender recognized only by a service seat.
      dispatchKeywordAllowed: false,
    });
    say(`  "DISPATCH" from a seat     → handled: ${bySeat.handled} · vendor runs opened: ${s.runCalls.map((c) => c.id).join(", ") || "none"}`);
    say("  (the keyword is not theirs to use: their id is the LINE OWNER's, not a workspace they hold)");
    expect(bySeat).toEqual({ handled: false });
    expect(s.runCalls).toEqual([]);
  });
});
