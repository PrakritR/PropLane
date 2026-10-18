import { fakeMigrationDb, type FakeRow } from "../helpers/migration-fake-db";

export const PROD_REF = "qahnczmilgptcedaqype";
export const DEV_REF = "emstjswhotsnyksqhqyf";
export const DEV_ENV = { NEXT_PUBLIC_SUPABASE_URL: `https://${DEV_REF}.supabase.co`, SUPABASE_SERVICE_ROLE_KEY: "key" };
export const PROD_ENV = { NEXT_PUBLIC_SUPABASE_URL: `https://${PROD_REF}.supabase.co`, SUPABASE_SERVICE_ROLE_KEY: "key" };

export const O1 = "owner-1";
export const O2 = "owner-2";
export const O3 = "owner-3-no-workspace";
export const WS1 = "11111111-1111-4111-8111-111111111111";
export const WS1B = "11111111-1111-4111-8111-1111111111bb";
export const WS2 = "22222222-2222-4222-8222-222222222222";
export const N1 = "num-1";
export const N2 = "num-2";
export const CONV1 = "conv-1";
export const CONV2 = "conv-2";
export const CONV3 = "conv-3";

/** Two owners with workspaces (one with two), a third with none, one number each, and a thread per owner. */
export function seed(extra: Record<string, FakeRow[]> = {}): Record<string, FakeRow[]> {
  return {
    sms_runtime_config: [{ singleton: true, line_mode: "per_workspace", shared_number_e164: null, shared_messaging_service_sid: null, shared_pilot_workspace_ids: [] }],
    portal_workspaces: [
      { id: WS1, owner_user_id: O1, name: "Brooklyn Homes", is_default: true, created_at: "2026-01-01T00:00:00Z", is_service: false },
      { id: WS1B, owner_user_id: O1, name: "Second", is_default: false, created_at: "2026-02-01T00:00:00Z", is_service: false },
      { id: WS2, owner_user_id: O2, name: "Eighth Ave", is_default: true, created_at: "2026-01-01T00:00:00Z", is_service: false },
    ],
    manager_sms_numbers: [
      { id: N1, manager_user_id: O1, workspace_id: WS1B, phone_number: "+12065550111", provision_state: "active", released_at: null },
      { id: N2, manager_user_id: O2, workspace_id: WS2, phone_number: "(206) 555-0222", provision_state: "active", released_at: null },
    ],
    workspace_work_numbers: [],
    profiles: [
      { id: "u-res", phone: "(206) 555-0142", phone_verified_at: "2026-09-01T00:00:00Z", full_name: "Rae Resident", sms_opt_out_at: null, sms_consent_at: null },
      { id: "u-ven", phone: "2065550177", phone_verified_at: null, full_name: "Vic Vendor", sms_opt_out_at: null, sms_consent_at: null },
      { id: "u-a", phone: "206-555-0188", phone_verified_at: "2026-09-01T00:00:00Z", full_name: "Twin A", sms_opt_out_at: null, sms_consent_at: null },
      { id: "u-b", phone: "(206) 555-0188", phone_verified_at: "2026-09-01T00:00:00Z", full_name: "Twin B", sms_opt_out_at: null, sms_consent_at: null },
      { id: "u-bad", phone: "not a phone", phone_verified_at: null, full_name: null, sms_opt_out_at: null, sms_consent_at: null },
    ],
    manager_sms_contacts: [
      { id: "c1", manager_user_id: O1, phone_e164: "+12065550142", counterparty_role: "resident", display_name: "Rae R", workspace_id: null },
      { id: "c2", manager_user_id: O2, phone_e164: "+12065550999", counterparty_role: "prospect", display_name: null, workspace_id: null },
    ],
    sms_phone_contacts: [],
    sms_projection_conversations: [
      { id: CONV1, owner_manager_user_id: O1, counterparty_role: "resident", work_line_id: N1, identity_key: "phone:+12065550142", counterparty_phone: "+12065550142", legacy_conversation_key: "k-old-1", conversation_key: null, merged_into_id: null, workspace_id: null, line_kind: "work_number", last_event_at: "2026-10-01T00:00:00Z" },
      { id: CONV2, owner_manager_user_id: O2, counterparty_role: "prospect", work_line_id: N2, identity_key: "phone:+12065550999", counterparty_phone: "+12065550999", legacy_conversation_key: "k-old-2", conversation_key: null, merged_into_id: null, workspace_id: null, line_kind: "work_number", last_event_at: "2026-10-02T00:00:00Z" },
      { id: CONV3, owner_manager_user_id: O1, counterparty_role: "resident", work_line_id: N1, identity_key: "phone:+12065550143", counterparty_phone: "+12065550143", legacy_conversation_key: "k-old-3", conversation_key: null, merged_into_id: CONV1, workspace_id: null, line_kind: "work_number", last_event_at: "2026-09-01T00:00:00Z" },
    ],
    sms_projection_aliases: [],
    sms_projection_turns: [
      { id: "t1", owner_manager_user_id: O1, conversation_id: CONV1, workspace_id: null },
      { id: "t2", owner_manager_user_id: O2, conversation_id: CONV2, workspace_id: null },
      { id: "t3", owner_manager_user_id: O1, conversation_id: CONV1, workspace_id: WS1 },
    ],
    sms_outbox: [
      { id: "o1", manager_user_id: O1, selected_work_line_id: N1, provider_from_phone: null, transport_from_number: null, workspace_id: null },
      { id: "o2", manager_user_id: O2, selected_work_line_id: null, provider_from_phone: "+12065550222", transport_from_number: null, workspace_id: null },
      { id: "o3", manager_user_id: O3, selected_work_line_id: null, provider_from_phone: null, transport_from_number: null, workspace_id: null },
    ],
    sms_inbound_receipts: [
      { message_sid: "SM1", manager_user_id: O1, inbound_payload: { workspaceId: WS1, toPhone: "+12065550111" }, workspace_id: null },
      { message_sid: "SM2", manager_user_id: O2, inbound_payload: { toPhone: "+12065550222" }, workspace_id: null },
      // A payload naming ANOTHER owner's workspace must not be trusted.
      { message_sid: "SM3", manager_user_id: O1, inbound_payload: { workspaceId: WS2 }, workspace_id: null },
    ],
    manager_sms_messages: [
      { id: "m1", manager_user_id: O1, direction: "outbound", from_phone: "+12065550111", to_phone: "+12065550142", resident_phone: "+12065550142", conversation_key: "k-old-1", workspace_id: null },
      { id: "m2", manager_user_id: O2, direction: "inbound", from_phone: "+12065550999", to_phone: "+12065550222", resident_phone: "+12065550999", conversation_key: "k-old-2", workspace_id: null },
    ],
    inbound_sms_log: [
      { id: "l1", manager_user_id: O1, to_phone: "+12065550111", conversation_key: "k-old-1", workspace_id: null },
      { id: "l2", manager_user_id: null, to_phone: "+19995550000", conversation_key: null, workspace_id: null },
    ],
    sms_consent: [],
    sms_consent_events: [],
    sms_manager_entitlements: [],
    ...extra,
  };
}

export function world(extra: Record<string, FakeRow[]> = {}, options: Parameters<typeof fakeMigrationDb>[1] = {}) {
  return fakeMigrationDb(seed(extra), options);
}

export function harness() {
  const lines: string[] = [];
  const report: Record<string, any> = {};
  return { lines, report, log: (l: string) => lines.push(l), text: () => lines.join("\n") };
}
