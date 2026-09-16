/**
 * WS4(shared-avail): `listOpenTourSlots` used to derive hosts ONLY from
 * `manager_property_records` ownership — an accepted co-manager's own painted
 * availability was computed (`publishedSlotsByManager`) but never actually
 * offered, because `offerings` only ever iterated the property's OWNER ids.
 * `slotHosts` must list every host open at a given slot, owner or co-manager.
 */
import { describe, expect, it } from "vitest";
import { vi } from "vitest";

const PROPERTY_ID = "mgr-demo-co-union";
const OWNER = "mgr-owner-union";
const CO_MANAGER = "mgr-co-union";

/** Far enough out that it can only be offered as an explicit publish, never
 * the auto-generated default grid — matches the convention in
 * `public-tour-availability-subtraction.test.ts`. */
const DAY = "2099-08-06";
const OWNER_ONLY_SLOT = `${DAY}:18`;
const SHARED_SLOT = `${DAY}:19`;
const CO_MANAGER_ONLY_SLOT = `${DAY}:20`;

class FakeNotLinkedError extends Error {}

vi.mock("@/lib/google-calendar/api.server", () => ({
  GOOGLE_CALENDAR_OPERATION_TIMEOUT_MS: 9_000,
  isGoogleCalendarNotLinkedError: (e: unknown) => e instanceof FakeNotLinkedError,
  listGoogleCalendarEvents: vi.fn(async () => {
    throw new FakeNotLinkedError("Google Calendar is not connected.");
  }),
}));
vi.mock("@/lib/public-host-label", () => ({
  publicSchedulingHostLabel: (input: { email?: string | null }) => input.email ?? "Host",
}));

function availabilityRow(managerUserId: string, slots: string[]) {
  return {
    id: `manager_property_availability_${managerUserId}_prop_${PROPERTY_ID}`,
    manager_user_id: managerUserId,
    property_id: PROPERTY_ID,
    record_type: "manager_property_availability",
    row_data: { payload: slots },
  };
}

function fakeDb() {
  const availabilityByManager: Record<string, string[]> = {
    [OWNER]: [OWNER_ONLY_SLOT, SHARED_SLOT],
    [CO_MANAGER]: [SHARED_SLOT, CO_MANAGER_ONLY_SLOT],
  };

  return {
    from(table: string) {
      if (table === "manager_property_records") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  manager_user_id: OWNER,
                  status: "live",
                  property_data: { id: PROPERTY_ID, buildingName: "Union House", address: "1 Union Ave" },
                },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "account_link_invites") {
        return {
          select: () => ({
            eq: () => ({
              eq: async () => ({
                data: [
                  {
                    invitee_user_id: CO_MANAGER,
                    assigned_property_ids: [PROPERTY_ID],
                    property_co_manager_permissions: {
                      [PROPERTY_ID]: { calendar: { read: true, edit: true } },
                    },
                  },
                ],
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "profiles") {
        return {
          select: () => ({
            in: async () => ({
              data: [
                { id: OWNER, email: "owner@x.com", full_name: "Owner" },
                { id: CO_MANAGER, email: "co@x.com", full_name: "Co-manager" },
              ],
            }),
          }),
        };
      }
      if (table === "portal_schedule_records") {
        let recordType = "";
        const builder: Record<string, unknown> = {
          select: () => builder,
          eq: (column: string, value: string) => {
            if (column === "record_type") recordType = value;
            if (column === "id" && value === "axis_admin_planned_events_v1") {
              builder.maybeSingle = async () => ({ data: { row_data: { payload: [] } }, error: null });
            }
            return builder;
          },
          in: async (column: string, values: string[]) => {
            if (recordType === "manager_property_availability") {
              const rows = Object.entries(availabilityByManager).map(([managerUserId, slots]) =>
                availabilityRow(managerUserId, slots),
              );
              return {
                data: rows.filter((row) =>
                  column === "manager_user_id" ? values.includes(row.manager_user_id) : values.includes(row.property_id),
                ),
                error: null,
              };
            }
            if (recordType === "manager_availability" || recordType === "partner_inquiry_request") {
              return { data: [], error: null };
            }
            return { data: [], error: null };
          },
          maybeSingle: async () => ({ data: null, error: null }),
        };
        return builder;
      }
      return {};
    },
  };
}

describe("listOpenTourSlots unions co-manager availability", () => {
  it("lists the owner alone, both hosts, and the co-manager alone on the right slots", async () => {
    const { listOpenTourSlots } = await import("@/lib/tour-availability.server");
    const result = await listOpenTourSlots(fakeDb() as never, { propertyId: PROPERTY_ID });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const ownerOnlyHosts = (result.slotHosts[OWNER_ONLY_SLOT] ?? []).map((h) => h.userId);
    const sharedHosts = (result.slotHosts[SHARED_SLOT] ?? []).map((h) => h.userId);
    const coManagerOnlyHosts = (result.slotHosts[CO_MANAGER_ONLY_SLOT] ?? []).map((h) => h.userId);

    expect(new Set(ownerOnlyHosts)).toEqual(new Set([OWNER]));
    // The core gap this closes: BOTH the owner and the co-manager are offered
    // for a slot they both painted, not just whichever one owns the property row.
    expect(new Set(sharedHosts)).toEqual(new Set([OWNER, CO_MANAGER]));
    expect(new Set(coManagerOnlyHosts)).toEqual(new Set([CO_MANAGER]));
  });
});
