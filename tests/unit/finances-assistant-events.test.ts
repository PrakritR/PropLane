// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  FINANCES_ASSISTANT_UPDATED_EVENT,
  expandDateFilterToInclude,
  notifyFinancesAssistantUpdated,
  postedDateFromPreviewFields,
} from "@/lib/finances-assistant-events";

describe("finances assistant events", () => {
  it("dispatches the confirmed books tool", () => {
    const seen: string[] = [];
    const onUpdated = (event: Event) => {
      seen.push((event as CustomEvent<{ tool?: string }>).detail?.tool ?? "");
    };
    window.addEventListener(FINANCES_ASSISTANT_UPDATED_EVENT, onUpdated);
    notifyFinancesAssistantUpdated({ tool: "record_expense" });
    notifyFinancesAssistantUpdated({ tool: "record_income" });
    window.removeEventListener(FINANCES_ASSISTANT_UPDATED_EVENT, onUpdated);
    expect(seen).toEqual(["record_expense", "record_income"]);
  });

  it("reads the posted date from the preview Date field", () => {
    expect(postedDateFromPreviewFields([{ label: "Amount", value: "$50.00" }, { label: "Date", value: "2024-09-04" }])).toBe(
      "2024-09-04",
    );
    expect(postedDateFromPreviewFields([{ label: "Date", value: "not-a-date" }])).toBeUndefined();
  });

  it("expands the open date filter so an out-of-range posted date is visible", () => {
    expect(expandDateFilterToInclude({ from: "2026-01-01", to: "2026-09-06" }, "2024-09-04")).toEqual({
      from: "2024-09-04",
      to: "2026-09-06",
    });
    expect(expandDateFilterToInclude({ from: "2026-01-01", to: "2026-09-06" }, "2026-09-20")).toEqual({
      from: "2026-01-01",
      to: "2026-09-20",
    });
    expect(expandDateFilterToInclude({ from: "2026-01-01", to: "2026-09-06" }, "2026-03-01")).toEqual({
      from: "2026-01-01",
      to: "2026-09-06",
    });
  });
});
