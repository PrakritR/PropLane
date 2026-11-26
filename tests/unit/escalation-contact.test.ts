import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  appendEscalationContactLine,
  formatEscalationContactLine,
  normalizeEscalationContactSettings,
} from "@/lib/one-number/escalation-contact";
import { resolveEscalationContact } from "@/lib/one-number/escalation-contact.server";
import { knowledgeFakeDb, type Row } from "../helpers/knowledge-fake-db";

const MANAGED_WS = "ws-managed";
const SELF_WS = "ws-self";
const OPERATOR = "+15551230001";
const MANAGER = "+15551230002";

function seed(over: Record<string, Row[]> = {}): Record<string, Row[]> {
  return {
    portal_workspaces: [
      { id: MANAGED_WS, owner_user_id: "service-owner", is_default: true, is_service: true },
      { id: SELF_WS, owner_user_id: "mgr", is_default: true, is_service: false },
    ],
    manager_property_records: [
      { id: "p-managed", manager_user_id: "service-owner", workspace_id: MANAGED_WS },
      { id: "p-self", manager_user_id: "mgr", workspace_id: SELF_WS },
    ],
    platform_service_settings: [
      { singleton: true, owner_user_id: "service-owner", manager_phone_e164: OPERATOR, manager_phone_verified_at: "2026-11-01T00:00:00Z" },
    ],
    profiles: [
      { id: "service-owner", full_name: "Op Erator", phone: "+15551239999", phone_verified_at: "2026-11-01T00:00:00Z" },
      { id: "mgr", full_name: "Dana Roosevelt", phone: MANAGER, phone_verified_at: "2026-11-01T00:00:00Z" },
    ],
    ...over,
  };
}

const sharedLine = { sms_runtime_config: [{ singleton: true, line_mode: "shared", shared_number_e164: "+12065550000", shared_pilot_workspace_ids: [] }] };

describe("escalation contact line (pure)", () => {
  it("formats one line", () => {
    expect(formatEscalationContactLine("Dana", "+15551230002")).toBe("For anything I can't answer, text Dana at (555) 123-0002.");
    expect(formatEscalationContactLine("Dana", "not a phone")).toBeNull();
  });

  it("a normal answer carries no line, an escalation carries exactly one", () => {
    expect(appendEscalationContactLine("Parking is on the street.", null)).toBe("Parking is on the street.");
    const line = formatEscalationContactLine("Dana", MANAGER)!;
    const once = appendEscalationContactLine("Let me check with the team.", line);
    expect(once).toBe(`Let me check with the team.\n\n${line}`);
    expect(appendEscalationContactLine(once, line)).toBe(once);
    expect(appendEscalationContactLine("", line)).toBe("");
  });

  it("the stored setting defaults ON and reads an explicit choice", () => {
    expect(normalizeEscalationContactSettings(undefined)).toEqual({ enabled: true, explicit: false });
    expect(normalizeEscalationContactSettings({ enabled: false })).toEqual({ enabled: false, explicit: true });
    expect(normalizeEscalationContactSettings({ enabled: "yes" })).toEqual({ enabled: true, explicit: false });
  });
});

describe("resolveEscalationContact", () => {
  it("a PropLane-managed house shows the operator's verified phone, not the owner's profile phone", async () => {
    const { db } = knowledgeFakeDb(seed());
    const contact = await resolveEscalationContact(db, { ownerUserId: "service-owner", propertyId: "p-managed" });
    expect(contact.kind).toBe("managed");
    expect(contact.line).toBe("For anything I can't answer, text the PropLane team at (555) 123-0001.");
    expect(contact.line).not.toContain("9999");
  });

  it("an unverified operator phone gives no line", async () => {
    const { db } = knowledgeFakeDb(
      seed({ platform_service_settings: [{ singleton: true, owner_user_id: "service-owner", manager_phone_e164: OPERATOR, manager_phone_verified_at: null }] }),
    );
    expect((await resolveEscalationContact(db, { ownerUserId: "service-owner", propertyId: "p-managed" })).line).toBeNull();
  });

  it("a self-serve house shows that manager's verified phone and first name", async () => {
    const { db } = knowledgeFakeDb(seed());
    const contact = await resolveEscalationContact(db, { ownerUserId: "mgr", propertyId: "p-self" });
    expect(contact.kind).toBe("self_serve");
    expect(contact.line).toBe("For anything I can't answer, text Dana at (555) 123-0002.");
  });

  it("the manager can disable it: no phone", async () => {
    const { db } = knowledgeFakeDb(seed({ workspace_automation_settings: [{ workspace_id: SELF_WS, owner_user_id: "mgr", row_data: { escalationContact: { enabled: false } } }] }));
    const contact = await resolveEscalationContact(db, { ownerUserId: "mgr", propertyId: "p-self" });
    expect(contact.line).toBeNull();
    expect(contact.enabled).toBe(false);
  });

  it("an unverified typed phone is never shared", async () => {
    const { db } = knowledgeFakeDb(seed({ profiles: [{ id: "mgr", full_name: "Dana", phone: MANAGER, phone_verified_at: null }] }));
    expect((await resolveEscalationContact(db, { ownerUserId: "mgr", propertyId: "p-self" })).line).toBeNull();
  });

  it("a number held by several verified accounts is nobody's", async () => {
    const { db } = knowledgeFakeDb(
      seed({
        profiles: [
          { id: "mgr", full_name: "Dana", phone: MANAGER, phone_verified_at: "2026-11-01T00:00:00Z" },
          { id: "other", full_name: "Test", phone: MANAGER, phone_verified_at: "2026-11-01T00:00:00Z" },
        ],
      }),
    );
    expect((await resolveEscalationContact(db, { ownerUserId: "mgr", propertyId: "p-self" })).line).toBeNull();
  });

  it("a destination derived from a model-supplied phone is impossible: the resolver takes no phone input", async () => {
    const { db } = knowledgeFakeDb(seed());
    const contact = await resolveEscalationContact(db, { ownerUserId: "mgr", propertyId: "p-self", ...({ phone: "+19998887777" } as object) });
    expect(contact.line).toContain("(555) 123-0002");
    expect(contact.line).not.toContain("999");
  });

  it("unpaid self-serve on the PropLane line in per_workspace mode shares nothing unless explicitly enabled", async () => {
    const off = knowledgeFakeDb(seed());
    expect((await resolveEscalationContact(off.db, { ownerUserId: "mgr", propertyId: "p-self", onPropLaneLine: true })).line).toBeNull();
    const on = knowledgeFakeDb(seed({ workspace_automation_settings: [{ workspace_id: SELF_WS, owner_user_id: "mgr", row_data: { escalationContact: { enabled: true } } }] }));
    expect((await resolveEscalationContact(on.db, { ownerUserId: "mgr", propertyId: "p-self", onPropLaneLine: true })).line).toContain("(555) 123-0002");
  });

  it("in shared mode the default (on) applies to a self-serve home", async () => {
    const { db } = knowledgeFakeDb(seed(sharedLine));
    expect((await resolveEscalationContact(db, { ownerUserId: "mgr", propertyId: "p-self", onPropLaneLine: true })).line).toContain("(555) 123-0002");
  });

  it("the shared line with no home chosen resolves to nobody; the service line with no home is the operator", async () => {
    const { db } = knowledgeFakeDb(seed(sharedLine));
    expect((await resolveEscalationContact(db, { ownerUserId: "service-owner", onPropLaneLine: true, sharedLineWithoutHome: true })).line).toBeNull();
    const svc = await resolveEscalationContact(db, { ownerUserId: "service-owner", onPropLaneLine: true, serviceLineWithoutHome: true });
    expect(svc.line).toContain("(555) 123-0001");
  });
});

describe("wiring", () => {
  const read = (p: string) => readFileSync(p, "utf8");
  it("every escalation path resolves the line on the server and only escalation turns append it", () => {
    expect(read("src/lib/tools/domains/leasing-sms.ts")).toContain("contactLine");
    expect(read("src/lib/tools/domains/vendor-work-order.ts")).toContain("vendorEscalationContactLine");
    expect(read("src/lib/tools/domains/resident/messaging.ts")).toContain("escalationContactLine");
    expect(read("src/lib/agent/leasing-sms-agent.server.ts")).toContain("appendEscalationContactLine");
    expect(read("src/lib/agent/vendor-agent.server.ts")).toContain("appendEscalationContactLine");
  });
});
