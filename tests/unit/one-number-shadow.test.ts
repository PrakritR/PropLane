import { describe, expect, it, vi } from "vitest";
import { fakeSharedLineDb } from "../helpers/shared-line-fake-db";

const unassigned = vi.hoisted(() => vi.fn(async (..._a: unknown[]) => ({ leadId: "never", reply: null, assignedWorkspaceId: null })));
vi.mock("@/lib/one-number/onboarding/unknown-sender.server", () => ({ handleUnknownSenderInbound: unassigned }));

import { recordShadowDecision, shadowAgreement } from "@/lib/one-number/shadow.server";

const VERIFIED = "2026-10-01T00:00:00.000Z";
const seed = {
  portal_workspaces: [{ id: "ws-a", name: "Brooklyn Homes", owner_user_id: "owner-a", is_default: true }],
  manager_property_records: [{ id: "p", manager_user_id: "owner-a", workspace_id: "ws-a", row_data: { buildingName: "5259 Brooklyn" } }],
  profiles: [{ id: "u", email: "u@x.com", phone: "+12065550142", phone_verified_at: VERIFIED }],
  manager_application_records: [{ id: "a", manager_user_id: "owner-a", resident_email: "u@x.com", property_id: "p", row_data: { bucket: "approved" } }],
};
const inbound = { fromPhone: "+12065550142", phoneKey: "2065550142", body: "hi", messageSid: "SM-s", mediaCount: 0 };

describe("recordShadowDecision", () => {
  it("stores what the router would have decided next to the real owner, with no other side effect", async () => {
    const { db, rows } = fakeSharedLineDb(seed);
    const result = await recordShadowDecision(db, { inbound, actualOwnerUserId: "owner-a", actualWorkspaceId: "ws-a" });
    expect(result).toEqual({ recorded: true });
    expect(rows.sms_line_shadow_decisions).toHaveLength(1);
    expect(rows.sms_line_shadow_decisions[0]).toMatchObject({
      message_sid: "SM-s", phone_key: "2065550142", actual_owner_user_id: "owner-a", actual_workspace_id: "ws-a", agrees: true,
      decision: { kind: "routed", workspaceId: "ws-a" },
    });
    expect(rows.sms_line_sessions).toBeUndefined();
    expect(unassigned).not.toHaveBeenCalled();
  });

  it("records a disagreement when the real owner is another workspace", async () => {
    const { db, rows } = fakeSharedLineDb(seed);
    await recordShadowDecision(db, { inbound, actualOwnerUserId: "owner-z", actualWorkspaceId: "ws-z" });
    expect(rows.sms_line_shadow_decisions[0].agrees).toBe(false);
  });

  it("is idempotent on the MessageSid", async () => {
    const { db, rows } = fakeSharedLineDb(seed);
    await recordShadowDecision(db, { inbound, actualOwnerUserId: "owner-a", actualWorkspaceId: "ws-a" });
    await recordShadowDecision(db, { inbound, actualOwnerUserId: "owner-a", actualWorkspaceId: "ws-a" });
    expect(rows.sms_line_shadow_decisions).toHaveLength(1);
  });

  it("never throws: a missing table, or a client that blows up, reports not recorded", async () => {
    const missing = fakeSharedLineDb(seed, { broken: ["sms_line_shadow_decisions"] });
    await expect(recordShadowDecision(missing.db, { inbound, actualOwnerUserId: "owner-a", actualWorkspaceId: "ws-a" })).resolves.toEqual({ recorded: false });
    const exploding = { from() { throw new Error("db down"); } } as never;
    await expect(recordShadowDecision(exploding, { inbound, actualOwnerUserId: "o", actualWorkspaceId: "w" })).resolves.toEqual({ recorded: false });
  });
});

describe("shadowAgreement", () => {
  const routed = { kind: "routed" as const, workspaceId: "w", ownerUserId: "o", role: "resident" as const, reason: "resident" as const, propertyId: null, label: "x" };
  it("matches on workspace, falls back to owner, and calls unassigned a disagreement", () => {
    expect(shadowAgreement(routed, { ownerUserId: "o", workspaceId: "w" })).toBe(true);
    expect(shadowAgreement(routed, { ownerUserId: "o", workspaceId: "other" })).toBe(false);
    expect(shadowAgreement(routed, { ownerUserId: "o", workspaceId: null })).toBe(true);
    expect(shadowAgreement(routed, { ownerUserId: null, workspaceId: null })).toBeNull();
    expect(shadowAgreement({ kind: "unassigned", role: "prospect", leadId: null }, { ownerUserId: "o", workspaceId: "w" })).toBe(false);
  });
  it("an ambiguous decision is not a disagreement when the real workspace is one of the options", () => {
    const ambiguous = { kind: "ambiguous" as const, candidates: [routed], question: "?" };
    expect(shadowAgreement(ambiguous, { ownerUserId: "o", workspaceId: "w" })).toBeNull();
    expect(shadowAgreement(ambiguous, { ownerUserId: "x", workspaceId: "z" })).toBe(false);
  });
});
