export type IcalEvent = {
  uid: string;
  summary: string;
  /** Inclusive calendar date YYYY-MM-DD (Pacific wall date for all-day events). */
  startDate: string;
  /** Inclusive calendar date YYYY-MM-DD. */
  endDate: string;
};

export type IcalDateRange = {
  start: string;
  end: string;
};
