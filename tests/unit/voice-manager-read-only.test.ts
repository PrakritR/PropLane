import { describe, expect, it } from "vitest";
import { buildManagerSmsRegistry } from "@/lib/tools";

describe("manager voice registry (caller ID is spoofable)", () => {
  it("readOnly option withholds every write tool for an owner caller", () => {
    const full = [...buildManagerSmsRegistry(null).values()];
    expect(full.some((t) => t.kind === "write")).toBe(true);
    const voice = [...buildManagerSmsRegistry(null, { readOnly: true }).values()];
    expect(voice.length).toBeGreaterThan(0);
    expect(voice.filter((t) => t.kind === "write")).toEqual([]);
  });
});
