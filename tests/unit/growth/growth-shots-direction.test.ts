import { describe, expect, it } from "vitest";

// @ts-expect-error plain .mjs script, no types
import { isLocalBase, parseDirection } from "../../../scripts/growth-shots.mjs";

describe("growth-shots parseDirection", () => {
  it("parses a route with a click action on an attribute selector", () => {
    expect(parseDirection("route:/portal/dashboard action:click[data-demo-target=approve]")).toEqual({
      route: "/portal/dashboard",
      action: { type: "click", selector: "[data-demo-target=approve]" },
    });
  });
  it("parses a route alone", () => {
    expect(parseDirection("route:/portal/properties")).toEqual({ route: "/portal/properties", action: null });
  });
  it("parses hover and scroll", () => {
    expect(parseDirection("route:/x action:hover#save").action).toEqual({ type: "hover", selector: "#save" });
    expect(parseDirection("route:/x action:scroll600").action).toEqual({ type: "scroll", px: 600 });
  });
  it("allows leading prose before the route", () => {
    expect(parseDirection("Show approvals. route:/portal/dashboard").route).toBe("/portal/dashboard");
  });
  it("rejects a direction with no route and unsupported actions", () => {
    expect(() => parseDirection("record the dashboard")).toThrow(/route/);
    expect(() => parseDirection("route:/x action:teleport[a]")).toThrow(/unsupported/);
    expect(() => parseDirection("route:/x action:click")).toThrow(/selector/);
  });
});

describe("growth-shots isLocalBase", () => {
  it("accepts localhost only", () => {
    expect(isLocalBase("http://localhost:3007")).toBe(true);
    expect(isLocalBase("http://127.0.0.1:3000")).toBe(true);
    expect(isLocalBase("https://prop-lane.space")).toBe(false);
    expect(isLocalBase("not a url")).toBe(false);
  });
});
