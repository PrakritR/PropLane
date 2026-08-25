import { normalizeTourNoticeDays, TOUR_NOTICE_DAY_OPTIONS } from "@/lib/tour-slot-math";

/** Human label for manager-facing tour notice controls. */
export function tourNoticeDaysLabel(noticeDays: number): string {
  const days = normalizeTourNoticeDays(noticeDays);
  if (days === 0) return "Same day";
  if (days === 1) return "Next day (1 day notice)";
  if (days === 7) return "1 week notice";
  return `${days} days notice`;
}

export const TOUR_NOTICE_DAY_SELECT_OPTIONS = TOUR_NOTICE_DAY_OPTIONS.map((days) => ({
  value: days,
  label: tourNoticeDaysLabel(days),
}));
