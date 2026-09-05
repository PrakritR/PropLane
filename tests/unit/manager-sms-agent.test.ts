/**
 * The manager SMS surface: a manager texting their own work number gets the
 * manager assistant, not a blind relay and not a regex command parser.
 *
 * Three things are load-bearing here and each has a test below:
 *  1. The registry withholds every destructive tool. Over SMS the only
 *     credential is the Twilio `From` header, which is attacker-influencable.
 *  2. Identity comes from a manager/owner/admin role and fails CLOSED on an
 *     unreadable role table — never "no roles, therefore fall through".
 *  3. A proposal from here is an ordinary `portal: "manager"` pending action,
 *     so the same confirm gate the portal chat route uses executes it.
 */
import { describe, expect, it } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";
import { agentRegistry, buildManagerSmsRegistry } from "@/lib/tools";
import { resolveManagerSmsAgentContext } from "@/lib/tools/manager-sms-context";
import { MANAGER_SMS_AGENT_SYSTEM_PROMPT } from "@/lib/agent/system-prompts";
import { PROMPT_IDS } from "@/lib/agent/prompt-metadata";
import { DELEGATED_SMS_UNSCOPED_TOOLS, type ManagerSmsAccess } from "@/lib/sms/manager-sms-access";

const MGR = "11111111-1111-4111-8111-111111111111";

describe("buildManagerSmsRegistry — destructive tools stay portal-only", () => {
  const registry = buildManagerSmsRegistry();

  it("withholds every destructive write tool", () => {
    const destructive = [...agentRegistry.values()].filter(
      (t) => t.kind === "write" && t.destructive,
    );
    // Guard the guard: if nothing is flagged destructive the filter proves nothing.
    expect(destructive.length).toBeGreaterThan(0);
    for (const tool of destructive) {
      expect(registry.has(tool.name)).toBe(false);
    }
  });

  it("names the known destructive tools, so a re-flagging is noticed", () => {
    const withheld = [...agentRegistry.keys()].filter((name) => !registry.has(name)).sort();
    expect(withheld).toEqual([
      "approve_and_pay_work_order",
      "cancel_calendar_event",
      "change_inspection_status",
      "delete_charge",
      "delete_promotion",
      "revoke_resident_access",
      "void_lease",
    ]);
  });

  it("keeps everything else, including the ordinary money writes behind the confirm gate", () => {
    for (const name of ["send_message", "create_charge", "mark_charge_paid", "create_work_order", "list_residents"]) {
      expect(registry.has(name)).toBe(true);
    }
  });

  it("withholds landlord-wide tools only on a delegated turn", () => {
    const delegated: ManagerSmsAccess = {
      mode: "delegated",
      workNumberOwnerId: MGR,
      actorUserId: "co-mgr",
      dataOwnerIds: [MGR],
      assignedPropertyIds: ["prop-1"],
    };
    const combined: ManagerSmsAccess = {
      mode: "combined",
      workNumberOwnerId: MGR,
      actorUserId: MGR,
      dataOwnerIds: [MGR, "other-owner"],
      assignedPropertyIds: ["prop-1"],
    };
    const delegatedRegistry = buildManagerSmsRegistry(delegated);
    const combinedRegistry = buildManagerSmsRegistry(combined);
    for (const name of DELEGATED_SMS_UNSCOPED_TOOLS) {
      expect(registry.has(name)).toBe(true);
      expect(combinedRegistry.has(name)).toBe(true);
      expect(delegatedRegistry.has(name)).toBe(false);
    }
    expect(delegatedRegistry.has("list_residents")).toBe(true);
    expect(delegatedRegistry.has("list_properties")).toBe(true);
  });

  it("derives the exclusion from the flag, not a name list — a newly destructive tool is withheld automatically", () => {
    const flagged = new Set(
      [...agentRegistry.values()].filter((t) => t.kind === "write" && t.destructive).map((t) => t.name),
    );
    const missing = [...agentRegistry.keys()].filter((name) => !registry.has(name));
    expect(new Set(missing)).toEqual(flagged);
  });
});

describe("resolveManagerSmsAgentContext", () => {
  it("resolves a manager to their own landlord scope", async () => {
    const db = createMemoryDb({
      profiles: [{ id: MGR, email: "Owner@Example.com", role: "manager" }],
      profile_roles: [{ user_id: MGR, role: "manager" }],
    }) as never;
    const res = await resolveManagerSmsAgentContext(db, { managerUserId: MGR });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // landlordId is the ownership key every manager tool scopes on. It is the
    // manager's own id and never comes from the inbound message.
    expect(res.ctx.landlordId).toBe(MGR);
    expect(res.ctx.userId).toBe(MGR);
    expect(res.ctx.email).toBe("owner@example.com");
  });

  it("prefers profile_roles over the legacy singular profiles.role", async () => {
    const db = createMemoryDb({
      // Created as a resident, later became a manager: the legacy column lies.
      profiles: [{ id: MGR, email: "both@example.com", role: "resident" }],
      profile_roles: [{ user_id: MGR, role: "resident" }, { user_id: MGR, role: "manager" }],
    }) as never;
    const res = await resolveManagerSmsAgentContext(db, { managerUserId: MGR });
    expect(res.ok).toBe(true);
  });

  it("refuses a texter who is not a manager, owner, or admin", async () => {
    const db = createMemoryDb({
      profiles: [{ id: MGR, email: "tenant@example.com", role: "resident" }],
      profile_roles: [{ user_id: MGR, role: "resident" }],
    }) as never;
    const res = await resolveManagerSmsAgentContext(db, { managerUserId: MGR });
    expect(res).toMatchObject({ ok: false, reason: "not_a_manager" });
  });

  it("refuses an unknown profile", async () => {
    const db = createMemoryDb({ profiles: [], profile_roles: [] }) as never;
    const res = await resolveManagerSmsAgentContext(db, { managerUserId: MGR });
    expect(res).toMatchObject({ ok: false, reason: "no_profile" });
  });

  it("refuses an empty manager id rather than resolving a blank scope", async () => {
    const db = createMemoryDb({ profiles: [], profile_roles: [] }) as never;
    expect(await resolveManagerSmsAgentContext(db, { managerUserId: "  " })).toMatchObject({
      ok: false,
    });
  });

  it("on a delegated turn keeps landlordId as the work-number owner and userId as the co-manager", async () => {
    const co = "22222222-2222-4222-8222-222222222222";
    const db = createMemoryDb({
      profiles: [{ id: co, email: "co@example.com", role: "manager" }],
      profile_roles: [{ user_id: co, role: "manager" }],
    }) as never;
    const access: ManagerSmsAccess = {
      mode: "delegated",
      workNumberOwnerId: MGR,
      actorUserId: co,
      dataOwnerIds: [MGR],
      assignedPropertyIds: ["prop-1"],
    };
    const res = await resolveManagerSmsAgentContext(db, {
      managerUserId: MGR,
      actorUserId: co,
      access,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.ctx.landlordId).toBe(MGR);
    expect(res.ctx.userId).toBe(co);
    expect(res.ctx.managerSmsAccess?.mode).toBe("delegated");
  });

  it("fails CLOSED when the role table cannot be read", async () => {
    const db = {
      from: (table: string) => ({
        select: () => ({
          eq: () =>
            table === "profile_roles"
              ? Promise.resolve({ data: null, error: { message: "boom" } })
              : {
                  maybeSingle: async () => ({
                    data: { email: "owner@example.com", role: "manager" },
                    error: null,
                  }),
                },
        }),
      }),
    } as never;
    // An unreadable role table must never read as "no roles" and fall through
    // to some other interpretation of the text.
    expect(await resolveManagerSmsAgentContext(db, { managerUserId: MGR })).toMatchObject({
      ok: false,
      reason: "lookup_failed",
    });
  });
});

describe("manager SMS prompt", () => {
  it("has its own prompt id so quality drops are attributable to this surface", () => {
    expect(PROMPT_IDS.managerSmsAgent).toBe("manager-sms-agent");
  });

  it("tells the manager the withheld actions are portal-only", () => {
    expect(MANAGER_SMS_AGENT_SYSTEM_PROMPT).toMatch(/portal-only/i);
  });

  it("keeps facts tool-grounded", () => {
    expect(MANAGER_SMS_AGENT_SYSTEM_PROMPT).toMatch(/must come from a tool result/i);
  });
});
