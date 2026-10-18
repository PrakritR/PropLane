export type IcalEvent = {
  uid: string;
  summary: string;
  /** The VEVENT DESCRIPTION, unfolded and unescaped. Read by sync for a few fixed fields; never stored raw. */
  description?: string;
  /** Inclusive calendar date YYYY-MM-DD (Pacific wall date for all-day events). */
  startDate: string;
  /** Inclusive calendar date YYYY-MM-DD. */
  endDate: string;
  /**
   * The check-in wall time ("HH:MM") when the feed publishes a local DATE-TIME start (floating or
   * TZID). Absent for an all-day event or a UTC value: the property's default time applies.
   */
  checkInTime?: string;
  /** The check-out wall time when the feed publishes a local DATE-TIME end on a later day than the start. */
  checkOutTime?: string;
};

export type IcalDateRange = {
  start: string;
  end: string;
};
