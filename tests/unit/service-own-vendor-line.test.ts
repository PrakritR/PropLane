/**
 * A PropLane Service workspace's OWN (non-roster) vendor with no work number to text from is texted through the PropLane line
 * as the service owner, under the service owner's vendor consent ledger; a workspace with a line of its own, or any other
 * workspace, keeps its own path; a STOP is final.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

const SO = "svc-owner";
const CLIENT = "client-1";
const OTHER = "plain-owner";
const WS_SVC = "ws-svc";
const WS_SVC_OWN_LINE = "ws-svc-own-line";
const WS_PLAIN = "ws-plain";
const WS_SO = "ws-so";

const state = vi.hoisted(() => ({
  ownLines: new Set<string>(),
  consent: "none" as "none" | "granted" | "opted_out",
  recorded: [] as Array<Record<string, unknown>>,
  transport: [] as Array<Record<string, unknown>>,
  legacy: [] as Array<Record<string, unknown>>,
}));

vi.mock("@/lib/one-number/config.server", () => ({
  loadSharedLineConfig: async () => ({ mode: "per_workspace", sharedNumber: null, messagingServiceSid: null, pilotWorkspaceIds: [] }),
  workspaceOnSharedLine: () => false,
}));
vi.mock("@/lib/sms/manager-number-provisioning.server", () => ({
  resolveWorkspaceSendLine: async (_db: unknown, _owner: string, workspaceId: string) => (state.ownLines.has(workspaceId) ? { phoneNumber: "+12065550001", numberId: "n1" } : null),
}));
vi.mock("@/lib/sms/vendor-conversation-consent.server", () => ({
  VENDOR_CONVERSATION_PURPOSE: "vendor_conversation",
  buildVendorSenderLine: (i: { managerFirstName?: string | null; workspaceName?: string | null }) => `- ${i.managerFirstName ?? "x"} at ${i.workspaceName} via PropLane. Reply STOP to opt out.`,
  carryVendorConsentToKey: async () => ({ ok: true }),
  readVendorTextConsent: async () => ({ ok: true, state: state.consent, conversationKey: "ck-so", grantedUnder: state.consent === "granted" ? "ck-so" : null, grantSource: null }),
  recordManagerAttestedVendorConsent: async (_db: unknown, input: Record<string, unknown>) => {
    state.recorded.push(input);
    state.consent = "granted";
    return { ok: true };
  },
}));
vi.mock("@/lib/proplane-sms-transport.server", () => ({
  sendFromManagerWorkNumber: async (args: Record<string, unknown>) => {
    state.transport.push(args);
    return { ok: true, outboxId: "ob-1" };
  },
}));
vi.mock("@/lib/manager-sms-send.server", () => ({
  sendManagerConversationSms: async (_db: unknown, args: Record<string, unknown>) => {
    state.legacy.push(args);
    return { status: 200, body: { ok: true, outboxId: "ob-legacy" } };
  },
}));
vi.mock("@/lib/communication/manager-assistant-workspace.server", () => ({ userDefaultWorkspaceId: async () => "ws-so" }));

import { sendVendorDispatchText } from "@/lib/vendor-dispatch/send.server";
import { resetPlatformServiceOwnerCache } from "@/lib/service/service-catalog.server";

const db = () =>
  createMemoryDb({
    platform_service_settings: [{ singleton: true, owner_user_id: SO }],
    portal_workspaces: [
      { id: WS_SVC, owner_user_id: CLIENT, is_service: true },
      { id: WS_SVC_OWN_LINE, owner_user_id: CLIENT, is_service: true },
      { id: WS_PLAIN, owner_user_id: OTHER, is_service: false },
      { id: WS_SO, owner_user_id: SO, is_service: false },
    ],
    manager_vendor_records: [{ id: "c-own", manager_user_id: CLIENT, vendor_user_id: null, row_data: { id: "c-own", name: "Client Plumber", phone: "+12065550301", active: true } }],
    profiles: [{ id: SO, full_name: "Prakrit Ramachandran" }],
  });

const send = (workspaceId: string, ownerUserId: string, key = "dispatch-offer-aaaaaaaa-w0") =>
  sendVendorDispatchText(db() as never, { ownerUserId, workspaceId, vendorDirectoryId: "c-own", phone: "+12065550301", text: "PropLane job #1: Leak in Seattle. Reply YES", idempotencyKey: key });

beforeEach(() => {
  state.ownLines = new Set();
  state.consent = "none";
  state.recorded = [];
  state.transport = [];
  state.legacy = [];
  resetPlatformServiceOwnerCache();
});

describe("a service workspace's own vendor with no work number", () => {
  it("is texted from the PropLane line as the service owner, with the sender line and STOP on the first text, and the consent recorded under the service owner", async () => {
    expect(await send(WS_SVC, CLIENT)).toEqual({ ok: true, outboxId: "ob-1" });
    expect(state.legacy).toHaveLength(0);
    expect(state.transport).toHaveLength(1);
    expect(state.transport[0]).toMatchObject({ managerUserId: SO, to: "+12065550301", purpose: "vendor_conversation", counterpartyRole: "vendor", conversationKey: "ck-so" });
    expect(String(state.transport[0]!.text)).toContain("Reply STOP to opt out");
    expect(state.recorded[0]).toMatchObject({ managerUserId: SO, phone: "+12065550301", vendorRecordId: "c-own" });
  });

  it("the sender line rides the first text only", async () => {
    await send(WS_SVC, CLIENT, "dispatch-offer-bbbbbbbb-w0");
    await send(WS_SVC, CLIENT, "dispatch-taken-cccccccc");
    expect(String(state.transport[0]!.text)).toContain("Reply STOP");
    expect(String(state.transport[1]!.text)).not.toContain("Reply STOP");
    expect(state.recorded).toHaveLength(1);
  });

  it("a STOP is final: nothing is sent", async () => {
    state.consent = "opted_out";
    expect(await send(WS_SVC, CLIENT)).toEqual({ ok: false, reason: "recipient_opted_out" });
    expect(state.transport).toHaveLength(0);
    expect(state.legacy).toHaveLength(0);
  });
});

describe("everything else keeps its own path", () => {
  it("a service workspace WITH its own attached line texts from it", async () => {
    state.ownLines.add(WS_SVC_OWN_LINE);
    await send(WS_SVC_OWN_LINE, CLIENT);
    expect(state.transport).toHaveLength(0);
    expect(state.legacy).toHaveLength(1);
    expect(state.legacy[0]).toMatchObject({ actorUserId: CLIENT, vendorRecordId: "c-own" });
  });

  it("a workspace that is not a service workspace never borrows the PropLane line", async () => {
    await send(WS_PLAIN, OTHER);
    expect(state.transport).toHaveLength(0);
    expect(state.legacy).toHaveLength(1);
  });
});
