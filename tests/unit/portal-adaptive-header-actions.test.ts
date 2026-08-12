import { describe, expect, it } from "vitest";
import {
  computeSharedSlotActionBudget,
  fitOptionalBetweenEdges,
  pickAdaptiveActions,
  pickVisibleActions,
  renderedAdaptiveRowWidth,
  resolveAdaptiveOptionalFitCount,
  splitAdaptiveActions,
  type PortalAdaptiveAction,
} from "@/lib/portal-adaptive-actions";

describe("pickVisibleActions", () => {
  const actions = [
    { id: "filter", node: null, menuItem: null, keepPriority: 1 },
    { id: "add", node: null, menuItem: null, keepPriority: 2 },
  ];

  it("keeps display order when everything fits", () => {
    expect(pickVisibleActions(actions, 2).map((action) => action.id)).toEqual(["filter", "add"]);
  });

  it("prefers higher keepPriority when only one optional action fits", () => {
    expect(pickVisibleActions(actions, 1).map((action) => action.id)).toEqual(["add"]);
  });
});

describe("pickAdaptiveActions", () => {
  const actions = [
    { id: "filter", node: null, menuItem: null, alwaysVisible: true, pinEdge: "start" as const },
    { id: "reminders", node: null, menuItem: null, keepPriority: 3 },
    { id: "setup", node: null, menuItem: null, keepPriority: 1 },
    { id: "add", node: null, menuItem: null, alwaysVisible: true, pinEdge: "end" as const },
  ];

  it("keeps filter and add on the edges even when no optional actions fit", () => {
    const result = pickAdaptiveActions(actions, 0);
    expect(result.visible.map((action) => action.id)).toEqual(["filter", "add"]);
    expect(result.overflow.map((action) => action.id)).toEqual(["reminders", "setup"]);
  });

  it("places optional actions between filter and add", () => {
    const result = pickAdaptiveActions(actions, 1);
    expect(result.visible.map((action) => action.id)).toEqual(["filter", "reminders", "add"]);
    expect(result.overflow.map((action) => action.id)).toEqual(["setup"]);
  });

  it("shows every action inline when optional space is ample", () => {
    const result = pickAdaptiveActions(actions, 2);
    expect(result.visible.map((action) => action.id)).toEqual(["filter", "reminders", "setup", "add"]);
    expect(result.overflow).toEqual([]);
  });
});

describe("resolveAdaptiveOptionalFitCount", () => {
  const actions: PortalAdaptiveAction[] = [
    { id: "filter", node: null, menuItem: null, alwaysVisible: true, pinEdge: "start" },
    { id: "a", node: null, menuItem: null, keepPriority: 3 },
    { id: "b", node: null, menuItem: null, keepPriority: 2 },
    { id: "c", node: null, menuItem: null, keepPriority: 1 },
    { id: "add", node: null, menuItem: null, alwaysVisible: true, pinEdge: "end" },
  ];

  const widthFor = (action: PortalAdaptiveAction) => {
    if (action.id === "filter") return 80;
    if (action.id === "add") return 100;
    if (action.id === "a") return 90;
    if (action.id === "b") return 90;
    if (action.id === "c") return 90;
    return 0;
  };

  it("fits every optional action when the row is wide enough", () => {
    expect(resolveAdaptiveOptionalFitCount(actions, widthFor, 40, 500, 2)).toBe(3);
  });

  it("keeps a partial optional row when only some middle buttons fit", () => {
    expect(resolveAdaptiveOptionalFitCount(actions, widthFor, 40, 300, 2)).toBe(0);
    expect(resolveAdaptiveOptionalFitCount(actions, widthFor, 40, 320, 2)).toBe(1);
    expect(resolveAdaptiveOptionalFitCount(actions, widthFor, 40, 420, 2)).toBe(2);
  });

  it("measures the rendered row using the same visible set as the UI", () => {
    expect(renderedAdaptiveRowWidth(actions, 1, widthFor, 40, 2)).toBe(80 + 2 + 90 + 2 + 100 + 2 + 40);
  });
});

describe("computeSharedSlotActionBudget", () => {
  it("subtracts filter siblings from the shared title-band slot", () => {
    expect(computeSharedSlotActionBudget(400, [72], 12)).toBe(316);
  });

  it("subtracts one gap per sibling in the band row", () => {
    expect(computeSharedSlotActionBudget(400, [72, 80], 12)).toBe(224);
  });

  it("returns zero when siblings consume the slot", () => {
    expect(computeSharedSlotActionBudget(80, [90], 8)).toBe(0);
  });
});

describe("fitOptionalBetweenEdges", () => {
  it("fits all optional actions when the row has room", () => {
    expect(fitOptionalBetweenEdges(80, [70, 90, 110], 100, 500, 40, 2)).toBe(3);
  });

  it("only reserves the overflow menu when optional actions do not all fit", () => {
    expect(fitOptionalBetweenEdges(80, [70, 90, 110], 100, 260, 40, 2)).toBeLessThan(3);
  });
});

describe("splitAdaptiveActions", () => {
  it("splits start-pinned, middle, and end-pinned actions", () => {
    const actions = [
      { id: "filter", node: null, menuItem: null, alwaysVisible: true, pinEdge: "start" as const },
      { id: "setup", node: null, menuItem: null },
      { id: "add", node: null, menuItem: null, alwaysVisible: true, pinEdge: "end" as const },
    ];
    expect(splitAdaptiveActions(actions)).toEqual({
      leading: [actions[0]],
      optional: [actions[1]],
      trailing: [actions[2]],
    });
  });
});
