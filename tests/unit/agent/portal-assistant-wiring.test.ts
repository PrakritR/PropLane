import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentRegistry } from "@/lib/tools";
import { residentAgentRegistry } from "@/lib/tools/resident-index";
import { vendorAgentRegistry } from "@/lib/tools/vendor-index";
import { vendorWorkOrderAgentRegistry, leasingSmsAgentRegistry } from "@/lib/tools";
import {
  MANAGER_SYSTEM_PROMPT,
  RESIDENT_SYSTEM_PROMPT,
  VENDOR_PORTAL_SYSTEM_PROMPT,
} from "@/lib/agent/system-prompts";

/**
 * Per-portal assistant wiring. `resolveAgentContext` REJECTS non-managers by
 * design, so a portal that mounts AxisAssistant without its own role-scoped
 * endpoint answers 401 to every question — that is exactly how the resident and
 * vendor assistants were silently broken. These pin the three-piece set
 * (endpoint + registry + persona) per role, and that the maps never cross.
 */
const repoRoot = join(__dirname, "..", "..", "..");
const read = (rel: string) => readFileSync(join(repoRoot, rel), "utf8");

describe("portal assistant endpoints", () => {
  it.each([
    ["src/app/resident/layout.tsx", "/api/agent/resident-chat"],
    ["src/app/vendor/layout.tsx", "/api/agent/vendor-chat"],
  ])("%s mounts the assistant against %s", (file, endpoint) => {
    const source = read(file);
    expect(source).toContain("<AxisAssistant");
    expect(source).toContain(`endpoint="${endpoint}"`);
  });

  it.each(["src/app/portal/layout.tsx", "src/app/admin/layout.tsx"])(
    "%s uses the default manager endpoint (resolveAgentContext accepts managers and admins)",
    (file) => {
      const source = read(file);
      expect(source).toContain("<AxisAssistant");
      expect(source).not.toContain("endpoint=");
    },
  );

  it("no portal passes a nonexistent `portal` prop instead of an endpoint", () => {
    for (const file of [
      "src/app/portal/layout.tsx",
      "src/app/resident/layout.tsx",
      "src/app/vendor/layout.tsx",
      "src/app/admin/layout.tsx",
    ]) {
      expect(read(file)).not.toMatch(/<AxisAssistant[^>]*\sportal=/);
    }
  });
});

describe("portal chat routes bind their own registry + persona", () => {
  it.each([
    ["src/app/api/agent/chat/route.ts", "agentRegistry", "MANAGER_SYSTEM_PROMPT", '"manager"'],
    ["src/app/api/agent/resident-chat/route.ts", "buildResidentRegistry(ctx)", "RESIDENT_SYSTEM_PROMPT", '"resident"'],
    ["src/app/api/agent/vendor-chat/route.ts", "vendorAgentRegistry", "VENDOR_PORTAL_SYSTEM_PROMPT", '"vendor"'],
  ])("%s", (file, registry, prompt, portal) => {
    const source = read(file);
    expect(source).toContain(`registry: ${registry}`);
    expect(source).toContain(`const system = withAgentCustomInstructions(${prompt}, customInstructions)`);
    expect(source).toContain("resolvePromptMeta(");
    expect(source).toContain("system,");
    expect(source).toContain("loadAgentCustomInstructions(ctx.db, ctx.userId)");
    expect(source).toContain("handleAgentChatHistoryRequest");
    // The session is created lazily on the first message via ensureAgentSession,
    // so an empty "New chat" the user never sends into is never persisted.
    expect(source).toContain("ensureAgentSession");
    expect(source).not.toContain("body.newSession");
    // The confirm gate is bound to the SAME portal, so a proposal made in one
    // portal can never be confirmed against another portal's tool of the same name.
    expect(source).toContain(`portal: ${portal}`);
    expect(source).toContain("handlePendingActionDecision");
  });

  it("only the manager route opts into the inline-write allowlist", () => {
    expect(read("src/app/api/agent/chat/route.ts")).toContain(
      "allowWriteTools: MANAGER_INLINE_WRITE_TOOLS",
    );
    for (const file of [
      "src/app/api/agent/resident-chat/route.ts",
      "src/app/api/agent/vendor-chat/route.ts",
      "src/app/api/agent/demo-chat/route.ts",
    ]) {
      expect(read(file)).not.toContain("allowWriteTools");
    }
  });
});

describe("role registries never cross", () => {
  const manager = new Set([...agentRegistry.keys()]);
  const resident = new Set([...residentAgentRegistry.keys()]);
  const vendor = new Set([...vendorAgentRegistry.keys()]);

  it("no manager-scoped capability appears in the resident or vendor map", () => {
    // Anything that reads or writes the LANDLORD's portfolio. A handful of
    // generic verbs (schedule_message) legitimately exist per role — those are
    // covered below.
    const managerOnly = [
      "send_rent_reminder",
      "get_overdue_charges",
      "list_charges",
      "create_charge",
      "list_residents",
      "list_applications",
      "list_properties",
      "list_inbox_threads",
      "list_service_requests",
      "run_financial_report",
      "record_expense",
      "record_income",
      "approve_and_pay_work_order",
      "set_resident_approval",
      "revoke_resident_access",
    ];
    for (const name of managerOnly) {
      expect(manager.has(name), `${name} should be a manager tool`).toBe(true);
      expect(resident.has(name), `${name} leaked into the resident registry`).toBe(false);
      expect(vendor.has(name), `${name} leaked into the vendor registry`).toBe(false);
    }
  });

  it("a name shared across roles is a DIFFERENT tool per registry, never the manager's", () => {
    for (const name of [...resident, ...vendor]) {
      if (!manager.has(name)) continue;
      const managerTool = agentRegistry.get(name)!;
      const roleTool = residentAgentRegistry.get(name) ?? vendorAgentRegistry.get(name)!;
      expect(roleTool, `${name} must be its own role-scoped implementation`).not.toBe(managerTool);
    }
  });

  /**
   * Tour availability and filing a tour request are PUBLIC-shaped capabilities:
   * the same grid the website shows anonymously, and the same request the
   * website's form files. They are the only names allowed to appear on an SMS
   * surface and in a portal registry. Everything else on an SMS surface must be
   * unique to it — that is what keeps a texting prospect or a one-job vendor
   * away from a manager's financials and a resident's records.
   */
  const SMS_SHARED_PUBLIC_TOOLS = new Set(["list_open_tour_slots", "request_tour"]);

  it("the SMS registries stay tiny and see no manager financials or resident data", () => {
    const smsNames = [...vendorWorkOrderAgentRegistry.keys(), ...leasingSmsAgentRegistry.keys()];
    for (const name of smsNames) {
      if (SMS_SHARED_PUBLIC_TOOLS.has(name)) continue;
      expect(manager.has(name), `${name} is a manager tool`).toBe(false);
      expect(resident.has(name), `${name} is a resident tool`).toBe(false);
    }
    expect(vendorWorkOrderAgentRegistry.size).toBeLessThanOrEqual(6);
    expect(leasingSmsAgentRegistry.size).toBeLessThanOrEqual(8);
  });

  it("the one-job vendor SMS agent shares nothing at all", () => {
    // The exemption above is scoped to leasing. A vendor texting about one work
    // order has no business seeing tour availability either.
    for (const name of vendorWorkOrderAgentRegistry.keys()) {
      expect(manager.has(name), `${name} is a manager tool`).toBe(false);
      expect(resident.has(name), `${name} is a resident tool`).toBe(false);
    }
  });

  it("every write tool in every registry is confirm-gated behind a preview", () => {
    for (const registry of [
      agentRegistry,
      residentAgentRegistry,
      vendorAgentRegistry,
      vendorWorkOrderAgentRegistry,
      leasingSmsAgentRegistry,
    ]) {
      for (const tool of registry.values()) {
        if (tool.kind !== "write") continue;
        expect(typeof tool.preview, `${tool.name} has no preview`).toBe("function");
      }
    }
  });
});

describe("personas are role-scoped", () => {
  it("each portal gets its own persona, and none of them is the manager one", () => {
    expect(RESIDENT_SYSTEM_PROMPT).not.toBe(MANAGER_SYSTEM_PROMPT);
    expect(VENDOR_PORTAL_SYSTEM_PROMPT).not.toBe(MANAGER_SYSTEM_PROMPT);
    expect(RESIDENT_SYSTEM_PROMPT).not.toBe(VENDOR_PORTAL_SYSTEM_PROMPT);
  });

  it("the resident persona addresses a resident, never a landlord", () => {
    expect(RESIDENT_SYSTEM_PROMPT).toMatch(/resident/i);
    expect(RESIDENT_SYSTEM_PROMPT).not.toMatch(/\blandlord\b/i);
    expect(RESIDENT_SYSTEM_PROMPT).not.toMatch(/their (own )?portfolio/i);
  });

  it("the vendor persona addresses a vendor, never a landlord", () => {
    expect(VENDOR_PORTAL_SYSTEM_PROMPT).toMatch(/vendor/i);
    expect(VENDOR_PORTAL_SYSTEM_PROMPT).not.toMatch(/\blandlord\b/i);
  });

  it("every persona names the product PropLane, never the legacy Axis brand", () => {
    for (const prompt of [MANAGER_SYSTEM_PROMPT, RESIDENT_SYSTEM_PROMPT, VENDOR_PORTAL_SYSTEM_PROMPT]) {
      expect(prompt).toContain("PropLane");
      expect(prompt).not.toMatch(/Axis (Assistant|Housing)/);
    }
  });

  it("manager persona allows promotion tools inside the New promotion modal", () => {
    expect(MANAGER_SYSTEM_PROMPT).toMatch(/New promotion modal/i);
    expect(MANAGER_SYSTEM_PROMPT).toContain("create_promotion");
    expect(MANAGER_SYSTEM_PROMPT).toContain("referenceImageUrls");
  });

  it("manager persona allows lease config updates inside the Lease modal", () => {
    expect(MANAGER_SYSTEM_PROMPT).toContain("update_property_lease_config");
    expect(MANAGER_SYSTEM_PROMPT).toMatch(/Lease modal/i);
  });
});

describe("assistant reliability — no generic dead-end errors", () => {
  const banned = "The assistant ran into an error. Please try again.";

  it("agent API routes and confirm gate never return the banned string", () => {
    const agentDir = join(repoRoot, "src/app/api/agent");
    const files = readdirSync(agentDir)
      .filter((f) => f.endsWith(".ts"))
      .map((f) => join(agentDir, f));
    files.push(join(repoRoot, "src/lib/agent/pending-action-decision.ts"));
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toContain(banned);
    }
  });

  it("portal chat routes use formatAgentChatUserError in catch blocks", () => {
    for (const file of [
      "src/app/api/agent/chat/route.ts",
      "src/app/api/agent/resident-chat/route.ts",
      "src/app/api/agent/vendor-chat/route.ts",
    ]) {
      const source = read(file);
      expect(source).toContain("formatAgentChatUserError");
    }
  });
});
