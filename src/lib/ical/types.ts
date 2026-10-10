export type IcalEvent = {
  uid: string;
  summary: string;
  /** The VEVENT DESCRIPTION, unfolded and unescaped. Read by sync for a few fixed fields; never stored raw. */
  description?: string;
  /** Inclusive calendar date YYYY-MM-DD (Pacific wall date for all-day events). */
  startDate: string;
  /** Inclusive calendar date YYYY-MM-DD. */
  endDate: string;
};

export type IcalDateRange = {
  start: string;
  end: string;
};
