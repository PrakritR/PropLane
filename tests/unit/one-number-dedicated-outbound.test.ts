import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

vi.mock("@/lib/one-number/personal-number-entitlement.server", () => ({
  managerPersonalNumberEntitlement: vi.fn(async () => ({ ok: true as const, entitled: true as const, via: "plan" as const, tier: "pro" as const })),
}));
vi.mock("@/lib/comms-billing/eligibility.server", () => ({ evaluateManagerCommsBillingGate: vi.fn(async () => ({ allowed: true })) }));
vi.mock("@/lib/sms/number-registration-policy", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/sms/number-registration-policy")>()),
  evaluateManagerSmsNumberSendability: vi.fn(() => ({ sendable: true })),
}));
const sharedSend = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ ok: true as const, messageSid: "SMs", segments: 1 })));
vi.mock("@/lib/one-number/send.server", () => ({ sendSharedLineMessage: sharedSend }));
const workNumberSend = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ ok: true as const, sid: "SMw" })));
vi.mock("@/lib/proplane-sms-transport.server", () => ({ sendFromManagerWorkNumber: workNumberSend }));

import { workspaceHasDedicatedNumber, workspaceOnSharedLine } from "@/lib/one-number/config.server";
import { sendWorkspacePhoneText } from "@/lib/one-number/link-text.server";
import { resolveConversationSendLine } from "@/lib/sms/manager-workspace-role.server";
import { evaluateWorkspaceSendReadiness } from "@/lib/sms/workspace-send-readiness.server";

const OWNER = "owner-1";
const SHARED = "+12065550100";
const OWN = "+12065550111";

function world(mode: "shared" | "per_workspace" = "shared") {
  return createMemoryDb({
    sms_runtime_config: [{
      singleton: true, mode: "automatic", pilot_manager_user_ids: [],
      line_mode: mode, shared_number_e164: SHARED, shared_messaging_service_sid: "MGshared", shared_pilot_workspace_ids: [],
    }],
    portal_workspaces: [
      { id: "ws-free", name: "Free Homes", owner_user_id: OWNER, is_default: true },
      { id: "ws-pro", name: "Pro Homes", owner_user_id: OWNER, is_default: false },
    ],
    manager_sms_numbers: [{
      id: "n-pro", manager_user_id: OWNER, workspace_id: "ws-pro", phone_number: OWN, phone_number_sid: "PN1",
      messaging_service_sid: "MGdefault", campaign_sid: "CP1", provision_state: "active", registration_state: "approved",
      registration_ref: null, attachment_state: "attached", number_registration_state: "registered", released_at: null,
      grace_started_at: null, grace_expires_at: null, quarantined_at: null, quarantine_reason: null,
    }],
    manager_property_records: [
      { id: "h-free", manager_user_id: OWNER, workspace_id: "ws-free" },
      { id: "h-pro", manager_user_id: OWNER, workspace_id: "ws-pro" },
    ],
  });
}

beforeEach(() => {
  sharedSend.mockClear();
  workNumberSend.mockClear();
  process.env.TWILIO_MESSAGING_SERVICE_SID = "MGdefault";
  process.env.TWILIO_CAMPAIGN_SID = "CP1";
});

const readiness = (db: ReturnType<typeof world>, over: Record<string, unknown>) =>
  evaluateWorkspaceSendReadiness({ db: db as never, ownerUserId: OWNER, requiredCents: 3, ...over });

describe("send readiness: own number when dedicated, shared line otherwise", () => {
  it("a Free workspace on the shared line sends from the shared number", async () => {
    const result = await readiness(world(), { sharedLineWorkspaceId: "ws-free" });
    expect(result).toMatchObject({ canSend: true, viaSharedLine: true, workspaceId: "ws-free" });
    expect(result.canSend && result.numberRow.phone_number).toBe(SHARED);
  });

  it("a Pro workspace with a number never sends from the shared number, even when it is not the owner's default", async () => {
    const result = await readiness(world(), { sharedLineWorkspaceId: "ws-pro" });
    expect(result).toMatchObject({ canSend: true, workspaceId: "ws-pro" });
    expect(result.canSend && result.viaSharedLine).toBeFalsy();
    expect(result.canSend && result.numberRow.phone_number).toBe(OWN);
  });

  it("a house in the Pro workspace sends from its number; a house in the Free one from the shared line", async () => {
    const pro = await readiness(world(), { propertyId: "h-pro" });
    expect(pro.canSend && pro.numberRow.phone_number).toBe(OWN);
    const free = await readiness(world(), { propertyId: "h-free" });
    expect(free.canSend && free.numberRow.phone_number).toBe(SHARED);
  });

  it("per_workspace mode is unchanged: the owner's default workspace line, which Free Homes does not have", async () => {
    const result = await readiness(world("per_workspace"), { sharedLineWorkspaceId: "ws-pro" });
    expect(result.canSend).toBe(false);
    const own = await readiness(world("per_workspace"), { workspaceId: "ws-pro" });
    expect(own.canSend && own.numberRow.phone_number).toBe(OWN);
  });
});

describe("conversation send line", () => {
  it("a thread that began on the shared line answers from the workspace's own number once it has one", async () => {
    const line = await resolveConversationSendLine(world() as never, OWNER, { linePhones: [SHARED], propertyId: "h-pro" });
    expect(line).toMatchObject({ ok: true, numberId: "n-pro", phoneNumber: OWN, via: "house" });
  });

  it("a Free workspace's shared-line thread keeps answering from the shared number", async () => {
    const line = await resolveConversationSendLine(world() as never, OWNER, { linePhones: [SHARED], propertyId: "h-free" });
    expect(line).toMatchObject({ ok: true, numberId: null, phoneNumber: SHARED, via: "shared" });
  });

  it("per_workspace: a shared hint matches nothing, as before", async () => {
    const line = await resolveConversationSendLine(world("per_workspace") as never, OWNER, { linePhones: [SHARED], propertyId: "h-pro" });
    expect(line).toMatchObject({ ok: true, via: "house", phoneNumber: OWN });
  });
});

describe("link and code texts", () => {
  const send = (db: ReturnType<typeof world>, workspaceId: string) =>
    sendWorkspacePhoneText(db as never, { workspaceId, phoneKey: "2065550142", body: "Your code is 123456", role: "resident", idempotencyKey: "k-1234567890123456" });

  it("a Pro workspace's code leaves from its own number, pinned to that workspace", async () => {
    expect(await send(world(), "ws-pro")).toBe(true);
    expect(sharedSend).not.toHaveBeenCalled();
    expect(workNumberSend).toHaveBeenCalledWith(expect.objectContaining({ managerUserId: OWNER, workspaceId: "ws-pro" }));
  });

  it("a Free workspace's code leaves on the shared line", async () => {
    expect(await send(world(), "ws-free")).toBe(true);
    expect(sharedSend).toHaveBeenCalledTimes(1);
    expect(workNumberSend).not.toHaveBeenCalled();
  });

  it("per_workspace: the work-number path, as before", async () => {
    expect(await send(world("per_workspace"), "ws-free")).toBe(true);
    expect(sharedSend).not.toHaveBeenCalled();
    expect(workNumberSend).toHaveBeenCalledTimes(1);
  });
});

describe("the decision helpers agree", () => {
  it("dedicated and shared are exclusive", () => {
    const config = { mode: "shared" as const, sharedNumber: SHARED, messagingServiceSid: null, pilotWorkspaceIds: [], dedicatedWorkspaceIds: ["ws-pro"] };
    expect(workspaceHasDedicatedNumber(config, "ws-pro")).toBe(true);
    expect(workspaceOnSharedLine(config, "ws-pro")).toBe(false);
    expect(workspaceHasDedicatedNumber(config, "ws-free")).toBe(false);
    expect(workspaceOnSharedLine(config, "ws-free")).toBe(true);
  });
});
