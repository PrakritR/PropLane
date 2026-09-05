import { describe, expect, it } from "vitest";
import type { ManagerSubscriptionTier } from "@/lib/manager-access";
import type { ResidentAgentContext } from "@/lib/tools/resident-context";
import { buildResidentRegistry, residentAgentRegistry } from "@/lib/tools/resident-index";

function gatingCtx(phase: "application" | "approved", managerTier: ManagerSubscriptionTier): ResidentAgentContext {
  return {
    kind: "resident",
    userId: "resident_a",
    email: "resa@axis.test",
    managerIds: ["manager_1"],
    phase,
    managerTier,
    landlordId: "resident_a",
    db: {},
  } as unknown as ResidentAgentContext;
}

const SERVICES_TOOLS = [
  "list_my_service_requests",
  "list_my_work_orders",
  "create_service_request",
  "add_service_request_note",
  // Maintenance filing is a Services capability and a separate model from
  // add-on service requests (AGENTS.md, "Add-on services vs. work orders").
  "report_maintenance_issue",
];

/** Documents is Pro-gated for residents exactly like Services and Inbox. */
const DOCUMENTS_TOOLS = ["list_my_shared_documents"];

const INBOX_TOOLS = [
  "list_my_inbox_threads",
  "get_my_scheduled_messages",
  "send_message_to_manager",
  "schedule_message",
  "cancel_scheduled_message",
];

const UNGATED_TOOLS = [
  "list_inspections",
  "get_inspection",
  "create_inspection",
  "save_inspection_observations",
  "change_inspection_status",
  // Tours are on no tier gate and no stage gate: touring is exactly what a
  // pre-approval resident does, and the availability grid it reads is the same
  // one the public website shows anonymously.
  "list_open_tour_slots",
  "request_tour",
  "get_my_balance",
  "list_my_charges",
  "get_my_payment_methods",
  "get_my_lease",
  "get_my_application_status",
  "get_move_in_info",
  "request_lease_extension",
  "report_manual_payment",
  "start_rent_payment",
];

describe("resident registry gating", () => {
  it("application-phase residents get application status and inbox tools", () => {
    const registry = buildResidentRegistry(gatingCtx("application", "paid"));
    expect([...registry.keys()].sort()).toEqual(
      [
        "get_my_application_status",
        "list_my_inbox_threads",
        "get_my_scheduled_messages",
        "send_message_to_manager",
        "schedule_message",
        "cancel_scheduled_message",
        "list_open_tour_slots",
        "request_tour",
      ].sort(),
    );
  });

  it("a free-tier manager hides services and documents tools but keeps communication", () => {
    const registry = buildResidentRegistry(gatingCtx("approved", "free"));
    for (const name of [...SERVICES_TOOLS, ...DOCUMENTS_TOOLS]) {
      expect(registry.has(name), `${name} should be tier-gated`).toBe(false);
    }
    for (const name of INBOX_TOOLS) {
      expect(registry.has(name), `${name} should stay available`).toBe(true);
    }
    for (const name of UNGATED_TOOLS) {
      expect(registry.has(name), `${name} should stay available`).toBe(true);
    }
  });

  it("approved phase on a paid manager exposes the full resident toolset", () => {
    const registry = buildResidentRegistry(gatingCtx("approved", "paid"));
    expect([...registry.keys()].sort()).toEqual(
      [...SERVICES_TOOLS, ...INBOX_TOOLS, ...DOCUMENTS_TOOLS, ...UNGATED_TOOLS].sort(),
    );
  });

  it("a null tier (no linked manager purchase) is not treated as free", () => {
    const registry = buildResidentRegistry(gatingCtx("approved", null));
    for (const name of [...SERVICES_TOOLS, ...INBOX_TOOLS, ...DOCUMENTS_TOOLS]) {
      expect(registry.has(name), `${name} should be available on null tier`).toBe(true);
    }
  });

  it("no manager tool names leak into the resident registry", () => {
    const managerToolNames = [
      "send_rent_reminder",
      "get_overdue_charges",
      "list_charges",
      "list_applications",
      "list_service_requests",
      "list_inbox_threads",
    ];
    for (const name of managerToolNames) {
      expect(residentAgentRegistry.has(name), `${name} is a manager tool`).toBe(false);
    }
  });

  it("all resident tool names are lowercase object_action snake case", () => {
    for (const name of residentAgentRegistry.keys()) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});
