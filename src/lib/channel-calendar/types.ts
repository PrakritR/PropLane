export const CHANNEL_CALENDAR_PROVIDERS = ["airbnb"] as const;
export type ChannelCalendarProvider = (typeof CHANNEL_CALENDAR_PROVIDERS)[number];

export const CHANNEL_CALENDAR_IMPORTED_RANGE_PREFIX = "channel-import";

export type ChannelCalendarImportedRange = {
  id: string;
  start: string;
  end: string;
  sourceUid: string;
  summary: string;
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
};

export type ManagerChannelBookingRange = {
  start: string;
  end: string;
  summary: string;
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
  hasImportUrl: boolean;
  /** iCal feed Airbnb reads for PropLane blocked dates on this room. */
  exportUrl: string;
};

export type ManagerChannelBookingProperty = {
  propertyId: string;
  propertyLabel: string;
  rooms: ManagerChannelBookingRoom[];
};
