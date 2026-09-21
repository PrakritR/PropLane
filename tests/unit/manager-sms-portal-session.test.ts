import { describe, expect, it, vi } from "vitest";

import { findOrCreatePortalAssistantSmsSession } from "@/lib/agent/sms-agent-turn.server";
import { createMemoryDb } from "./support/memory-supabase";

const OWNER = "11111111-1111-4111-8111-111111111111";
const ACTOR = "22222222-2222-4222-8222-222222222222";
const WORKSPACE = "44444444-4444-4444-8444-444444444444";

describe("manager self-SMS portal session", () => {
  it("continues the newest actor-scoped manager portal chat", async () => {
    const db = createMemoryDb({
      agent_sessions: [
        { id: "older", landlord_id: ACTOR, user_id: ACTOR, workspace_id: WORKSPACE, portal: "manager", kind: "portal_chat", vendor_phone_e164: null, status: "active", updated_at: "2026-09-19T12:00:00.000Z" },
        { id: "newest", landlord_id: ACTOR, user_id: ACTOR, workspace_id: WORKSPACE, portal: "manager", kind: "portal_chat", vendor_phone_e164: null, status: "active", updated_at: "2026-09-20T12:00:00.000Z" },
        { id: "other-workspace", landlord_id: ACTOR, user_id: ACTOR, workspace_id: "55555555-5555-4555-8555-555555555555", portal: "manager", kind: "portal_chat", updated_at: "2026-09-22T12:00:00.000Z" },
        { id: "foreign-actor", landlord_id: "33333333-3333-4333-8333-333333333333", user_id: "33333333-3333-4333-8333-333333333333", workspace_id: WORKSPACE, portal: "manager", kind: "portal_chat", updated_at: "2026-09-21T12:00:00.000Z" },
        { id: "legacy-sms", landlord_id: OWNER, user_id: ACTOR, portal: "manager", kind: "manager_sms", updated_at: "2026-09-22T12:00:00.000Z" },
      ],
    });

    await expect(findOrCreatePortalAssistantSmsSession(db as never, {
      actorUserId: ACTOR,
      workspaceId: WORKSPACE,
    })).resolves.toMatchObject({ id: "newest", kind: "portal_chat" });
  });

  it("creates a portal chat instead of a manager_sms session when none exists", async () => {
    const created = { id: "created-session", landlord_id: ACTOR, user_id: ACTOR, workspace_id: WORKSPACE, portal: "manager", kind: "portal_chat", vendor_phone_e164: null, status: "active" };
    let createdByRpc = false;
    const db = {
      rpc: vi.fn(async () => {
        createdByRpc = true;
        return { data: created.id, error: null };
      }),
      from: vi.fn(() => {
        const chain: Record<string, unknown> = {};
        chain.select = () => chain;
        chain.eq = () => chain;
        chain.is = () => chain;
        chain.order = () => chain;
        chain.limit = () => chain;
        chain.maybeSingle = async () => ({ data: createdByRpc ? created : null, error: null });
        return chain;
      }),
    };

    await expect(findOrCreatePortalAssistantSmsSession(db as never, {
      actorUserId: ACTOR,
      workspaceId: WORKSPACE,
    })).resolves.toMatchObject({ id: "created-session", kind: "portal_chat" });
    expect(db.rpc).toHaveBeenCalledWith("find_or_create_manager_sms_portal_session", {
      p_actor_user_id: ACTOR,
      p_workspace_id: WORKSPACE,
    });
  });
});
