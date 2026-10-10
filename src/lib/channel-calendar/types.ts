export const CHANNEL_CALENDAR_PROVIDERS = ["airbnb", "booking_com", "vrbo"] as const;
export type ChannelCalendarProvider = (typeof CHANNEL_CALENDAR_PROVIDERS)[number];

export const CHANNEL_CALENDAR_IMPORTED_RANGE_PREFIX = "channel-import";

export type ChannelCalendarImportedRange = {
  id: string;
  start: string;
  end: string;
  sourceUid: string;
  summary: string;
  /** The host's own calendar block ("Not available"), not a reservation. Derived from `summary` when absent. */
  hostBlock?: boolean;
};

export type ChannelCalendarConnectionPublic = {
  id: string;
  propertyId: string;
  roomId: string;
  provider: ChannelCalendarProvider;
  label: string | null;
  hasImportUrl: boolean;
  exportUrl: string;
  importedRangeCount: number;
  lastSyncedAt: string | null;
  lastError: string | null;
  /** When the channel last fetched PropLane's export feed (stamped by the export route). */
  exportLastFetchedAt: string | null;
};

export type ChannelCalendarConnectionRow = {
  id: string;
  manager_user_id: string;
  property_id: string;
  room_id: string;
  provider: ChannelCalendarProvider;
  label: string | null;
  import_url: string | null;
  export_token: string;
  imported_ranges: ChannelCalendarImportedRange[];
  last_synced_at: string | null;
  last_error: string | null;
  export_last_fetched_at: string | null;
};

export type ManagerChannelBookingRange = {
  sourceUid?: string;
  start: string;
  end: string;
  summary: string;
  /** The host's own calendar block; shown as "Airbnb block" and never counted as a booking. */
  hostBlock?: boolean;
};

export type ManagerChannelBookingRoom = {
  connectionId: string;
  roomId: string;
  roomLabel: string;
  provider: ChannelCalendarProvider;
  label: string | null;
  ranges: ManagerChannelBookingRange[];
  lastSyncedAt: string | null;
  lastError: string | null;
  /** When the channel last fetched PropLane's export feed for this room. */
  exportLastFetchedAt?: string | null;
  hasImportUrl: boolean;
  /** The manager's own saved channel link; returned only on the manager-scoped bookings route. */
  importUrl: string | null;
  exportUrl: string;
};

export type ManagerChannelBookingProperty = {
  propertyId: string;
  propertyLabel: string;
  rooms: ManagerChannelBookingRoom[];
};
