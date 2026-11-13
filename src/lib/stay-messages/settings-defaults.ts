/**
 * The DEFAULT contact number each source's check-in / check-out message names (design-1112 §7). These are only defaults: the
 * workspace's own value (Settings -> Automations, validated E.164, stored per workspace in
 * `workspace_automation_settings.row_data.stayMessages.contactPhone`) always wins, and no message template holds a number.
 */
export const STAY_SOURCES = ["direct", "proplane", "resident", "airbnb", "booking_com"] as const;
export type StaySource = (typeof STAY_SOURCES)[number];

export const DEFAULT_CONTACT_PHONE_BY_SOURCE: Readonly<Record<StaySource, string>> = Object.freeze({
  direct: "+12066781909",
  proplane: "+12066781909",
  resident: "+12066781909",
  airbnb: "+15103098345",
  booking_com: "+15103098345",
});

export const DEFAULT_SOURCE_ENABLED: Readonly<Record<StaySource, boolean>> = Object.freeze({
  direct: true,
  proplane: true,
  resident: true,
  airbnb: false,
  booking_com: false,
});
