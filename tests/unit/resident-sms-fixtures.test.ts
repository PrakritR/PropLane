import { describe, expect, it } from "vitest";
import { checkInReveal } from "@/lib/check-in-reveal";
import { houseInfoWithoutInternal, normalizeHouseInfo } from "@/lib/house-info";
import { RESIDENT_SMS_AGENT_SYSTEM_PROMPT } from "@/lib/agent/system-prompts";
import type { ResidentAgentContext } from "@/lib/tools/resident-context";
import { buildResidentRegistry } from "@/lib/tools/resident-index";

/**
 * A verified current resident texting the work number or the 206 line is answered by the resident agent, from tools only. These
 * fixtures pin, for each real kind of question, that the SMS registry hands the agent the tool that holds the answer, that the
 * prompt routes the question to it, and that the secrets stay behind the one reveal decision.
 */
const ctx = {
  kind: "resident",
  userId: "res-1",
  email: "res@axis.test",
  managerIds: ["mgr"],
  activeManagerId: "mgr",
  phase: "approved",
  managerTier: "pro",
  channel: "sms",
  landlordId: "res-1",
  db: {},
} as unknown as ResidentAgentContext;

const registry = buildResidentRegistry(ctx);
const has = (name: string) => registry.get(name) !== undefined;

const FIXTURES: Array<{ say: string; tools: string[]; promptMentions: RegExp }> = [
  { say: "what's the wifi", tools: ["lookup_property_knowledge", "get_move_in_info"], promptMentions: /Wi-Fi.*lookup_property_knowledge/s },
  { say: "door code?", tools: ["lookup_property_knowledge", "get_move_in_info"], promptMentions: /door or gate code.*lookup_property_knowledge/s },
  { say: "where do I park", tools: ["lookup_property_knowledge"], promptMentions: /parking.*lookup_property_knowledge/s },
  { say: "when is trash day", tools: ["lookup_property_knowledge"], promptMentions: /trash day/ },
  { say: "what are the house rules / quiet hours", tools: ["lookup_property_knowledge", "get_move_in_info"], promptMentions: /quiet hours, house rules/ },
  { say: "when is rent due", tools: ["get_my_balance"], promptMentions: /when is rent due.*get_my_balance/s },
  { say: "how much do I owe", tools: ["get_my_balance", "list_my_charges"], promptMentions: /get_my_balance/ },
  { say: "the sink is leaking", tools: ["report_maintenance_issue"], promptMentions: /report_maintenance_issue immediately/ },
  { say: "I'm locked out", tools: ["report_maintenance_issue"], promptMentions: /lockout/i },
  { say: "when can I move in / check-in instructions", tools: ["get_move_in_info", "get_my_stay_times"], promptMentions: /see house or move-in details/ },
  { say: "can I get a parking spot add-on", tools: ["create_service_request"], promptMentions: /create_service_request/ },
  { say: "send me the link to pay", tools: ["get_resident_links"], promptMentions: /get_resident_links/ },
];

describe("a verified resident's questions each have a read tool and a prompt route", () => {
  for (const fixture of FIXTURES) {
    it(`"${fixture.say}"`, () => {
      for (const tool of fixture.tools) expect(has(tool), `tool ${tool}`).toBe(true);
      expect(RESIDENT_SMS_AGENT_SYSTEM_PROMPT).toMatch(fixture.promptMentions);
    });
  }

  it("the registry is read-first: house info and the move-in guide are READ tools, and autopay stays out of SMS", () => {
    expect(registry.get("lookup_property_knowledge")?.kind).toBe("read");
    expect(registry.get("get_move_in_info")?.kind).toBe("read");
    expect(registry.get("get_my_balance")?.kind).toBe("read");
    expect(has("set_autopay")).toBe(false);
  });

  it("an application-phase guest does not get the lease and money tools", () => {
    const guest = buildResidentRegistry({ ...ctx, phase: "application" } as ResidentAgentContext);
    expect(guest.get("get_my_balance")).toBeUndefined();
    expect(guest.get("lookup_property_knowledge")).toBeDefined();
  });
});

describe("the door and room code: only through the one reveal decision", () => {
  const moveIn = "2026-12-01T22:00:00.000Z"; // the move-in date at check-in time

  it("'door code?' before the window gets no code, and the unlock time instead", () => {
    const early = checkInReveal({ kind: "tenancy", moveInAtIso: moveIn, leaseSigned: true }, new Date("2026-11-30T17:00:00.000Z"));
    expect(early).toMatchObject({ revealed: false, reason: "too_early", revealAtIso: "2026-11-30T18:00:00.000Z" });
  });

  it("'door code?' once the window opens (10:00 the day before), with a signed lease, gets the code", () => {
    expect(checkInReveal({ kind: "tenancy", moveInAtIso: moveIn, leaseSigned: true }, new Date("2026-11-30T18:00:01.000Z"))).toMatchObject({ revealed: true });
  });

  it("an unsigned lease never reveals, even after the window", () => {
    expect(checkInReveal({ kind: "tenancy", moveInAtIso: moveIn, leaseSigned: false }, new Date("2026-12-02T00:00:00.000Z"))).toMatchObject({ revealed: false, reason: "lease_unsigned" });
  });

  it("a short stay reveals only when confirmed and inside the window", () => {
    const stay = { kind: "stay" as const, checkInAtIso: moveIn, checkOutAtIso: "2026-12-05T18:00:00.000Z" };
    expect(checkInReveal({ ...stay, status: "pending" }, new Date("2026-12-01T23:00:00.000Z")).revealed).toBe(false);
    expect(checkInReveal({ ...stay, status: "confirmed" }, new Date("2026-12-01T23:00:00.000Z")).revealed).toBe(true);
    expect(checkInReveal({ ...stay, status: "confirmed" }, new Date("2026-12-06T00:00:00.000Z")).revealed).toBe(false);
  });

  it("the staff-only Internal section never reaches the agent: houseInfoWithoutInternal drops it", () => {
    const info = normalizeHouseInfo({
      wifi: { network: "Brooklyn-5G" },
      internal: { notes: "lockbox 4821" },
    } as never);
    const safe = houseInfoWithoutInternal(info) as unknown as Record<string, unknown>;
    expect(JSON.stringify(safe)).not.toContain("4821");
  });
});
