/** Fired when the assistant confirms a books write the open Finances page should reload. */
export const FINANCES_ASSISTANT_UPDATED_EVENT = "proplane:finances-assistant-updated";

export type FinancesAssistantUpdatedDetail = {
  tool: "record_expense" | "record_income";
  postedDate?: string;
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function postedDateFromPreviewFields(fields: { label: string; value?: string }[]): string | undefined {
  const value = fields.find((field) => field.label === "Date")?.value?.trim();
  return value && ISO_DATE.test(value) ? value : undefined;
}

export function expandDateFilterToInclude(
  filters: { from: string; to: string },
  postedDate: string,
): { from: string; to: string } {
  if (!ISO_DATE.test(postedDate)) return filters;
  return {
    from: postedDate < filters.from ? postedDate : filters.from,
    to: postedDate > filters.to ? postedDate : filters.to,
  };
}

export function notifyFinancesAssistantUpdated(detail: FinancesAssistantUpdatedDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(FINANCES_ASSISTANT_UPDATED_EVENT, { detail }));
}
