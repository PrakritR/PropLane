/**
 * Product-area permission catalog for externally issued manager credentials.
 * These lists are deliberately independent from UI labels: they are also the
 * server-side source used to turn an area toggle into exact tool permissions.
 */
export type ApiKeyTransport = "mcp" | "api";
export type ApiKeyProductAreaId =
  | "portfolio"
  | "leasing"
  | "payments"
  | "communication"
  | "calendar"
  | "maintenance"
  | "financials"
  | "operations";

export type ApiKeyProductArea = {
  id: ApiKeyProductAreaId;
  label: string;
  description: string;
  readTools: readonly string[];
  writeTools: readonly string[];
};

export const API_KEY_PRODUCT_AREAS: readonly ApiKeyProductArea[] = [
  {
    id: "portfolio",
    label: "Portfolio & residents",
    description: "Properties, listings, residents, documents, and your team.",
    readTools: ["list_properties", "get_property_details", "get_listing_creation_checklist", "get_listing_media_inventory", "list_residents", "list_documents", "list_co_managers"],
    writeTools: ["create_property", "update_property", "update_property_lease_config", "copy_listing_photos", "share_property_link", "create_listing_draft", "update_listing_draft", "apply_listing_photos", "set_resident_approval", "send_resident_welcome", "revoke_resident_access", "record_move_out"],
  },
  {
    id: "leasing",
    label: "Leasing & applications",
    description: "Applications, leases, signatures, and screening.",
    readTools: ["list_applications", "get_application_details", "list_leases", "list_lease_sections", "list_property_lease_template_sections"],
    writeTools: ["update_application_bucket", "order_background_check", "create_lease_draft", "update_lease_draft", "update_lease_packet", "propose_lease_section_edit", "propose_property_lease_template_section_edit", "amend_lease", "void_lease", "send_lease_for_signature"],
  },
  {
    id: "payments",
    label: "Charges & payments",
    description: "Resident charges, overdue balances, and payment reminders.",
    readTools: ["get_overdue_charges", "list_charges"],
    writeTools: ["send_rent_reminder", "create_charge", "update_charge", "delete_charge", "mark_charge_paid"],
  },
  {
    id: "communication",
    label: "Communication",
    description: "Inbox threads, replies, scheduled messages, and automations.",
    readTools: ["list_inbox_threads", "get_thread_messages", "list_scheduled_messages", "get_automation_settings"],
    writeTools: ["send_message", "reply_to_thread", "schedule_message", "cancel_scheduled_message", "update_thread", "update_automation_settings", "cancel_scheduled_reminder", "restore_scheduled_reminder", "reschedule_reminder"],
  },
  {
    id: "calendar",
    label: "Calendar & tours",
    description: "Availability, events, and prospective tenant tours.",
    readTools: ["list_calendar_events", "list_tour_inquiries", "list_open_tour_slots"],
    writeTools: ["update_manager_availability", "create_calendar_event", "cancel_calendar_event", "accept_tour_inquiry", "confirm_tour_inquiry", "book_tour", "reschedule_tour", "cancel_tour"],
  },
  {
    id: "maintenance",
    label: "Maintenance & vendors",
    description: "Service requests, work orders, bids, and vendor contacts.",
    readTools: ["list_service_requests", "list_work_orders", "suggest_vendors_for_work_order", "list_work_order_bids", "list_vendors"],
    writeTools: ["decide_service_request", "create_work_order", "assign_vendor", "offer_to_vendors", "schedule_vendor_visit", "accept_bid", "complete_work_order", "approve_and_pay_work_order", "send_work_order_reminder", "add_vendor", "update_vendor", "invite_vendor"],
  },
  {
    id: "financials",
    label: "Financials",
    description: "Reports, income, expenses, bills, budgets, and distributions.",
    readTools: ["run_financial_report"],
    writeTools: ["record_expense", "record_income", "create_manager_bill", "approve_manager_bill", "record_bill_payment", "create_manager_budget", "update_manager_budget", "dispose_security_deposit", "create_owner_distribution", "approve_owner_distribution", "reconcile_bank_statement_line"],
  },
  {
    id: "operations",
    label: "Workspace insights",
    description: "Portfolio search, dashboard data, profile, and promotions.",
    readTools: ["find_records", "get_manager_profile", "get_dashboard_summary", "list_promotions"],
    writeTools: ["create_promotion", "generate_promotion_flyer", "update_promotion", "delete_promotion"],
  },
];

export const API_KEY_TOOL_NAMES = new Set(
  API_KEY_PRODUCT_AREAS.flatMap((area) => [...area.readTools, ...area.writeTools]),
);
export const API_KEY_WRITE_TOOL_NAMES = new Set(API_KEY_PRODUCT_AREAS.flatMap((area) => area.writeTools));

export function toolsForProductAreas(selections: readonly string[]): string[] {
  const selected = new Set(selections);
  return Array.from(
    new Set(
      API_KEY_PRODUCT_AREAS.flatMap((area) => [
        ...(selected.has(`${area.id}:read`) || selected.has(`${area.id}:write`) ? area.readTools : []),
        ...(selected.has(`${area.id}:write`) ? area.writeTools : []),
      ]),
    ),
  );
}

export function productAreaSelectionsForTools(allowedTools: readonly string[]): string[] {
  const allowed = new Set(allowedTools);
  return API_KEY_PRODUCT_AREAS.flatMap((area) => {
    const read = area.readTools.length > 0 && area.readTools.every((tool) => allowed.has(tool));
    const write = area.writeTools.length > 0 && area.writeTools.every((tool) => allowed.has(tool));
    return write && read ? [`${area.id}:read`, `${area.id}:write`] : read ? [`${area.id}:read`] : [];
  });
}
