import { createInspectionDocument, type InspectionRecord } from "@/lib/inspections/model";

export function reportFixture(overrides: Partial<InspectionRecord> = {}): InspectionRecord {
  return { id: "11111111-1111-4111-8111-111111111111", application_id: "AXIS-TEST", manager_user_id: "owner", property_id: "home", resident_email: "resident@example.test", resident_user_id: "resident", resident_name: "Test Resident", property_label: "Test Home", room_label: "Room 1", kind: "move-in", status: "draft", inspection_date: "2026-09-05", baseline_id: null, revision: 1, document: createInspectionDocument(), created_at: "2026-09-05T00:00:00Z", updated_at: "2026-09-05T00:00:00Z", ...overrides };
}
