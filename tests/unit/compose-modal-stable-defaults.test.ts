import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * "Maximum update depth exceeded" in the compose modals came from two habits
 * that are individually harmless and lethal together:
 *
 *   1. `liveContacts = []` as a DEFAULT PARAMETER — a fresh array every render,
 *      so every memo and effect keyed on it re-runs forever.
 *   2. A pruning effect that calls `setState(prev => prev.filter(...))`, which
 *      always allocates a new array and therefore always re-renders.
 *
 * Either one alone is survivable. Together they loop: new default → new memo →
 * effect fires → setState with a new array → render → new default → …
 *
 * These are source-level assertions on purpose. The loop is a render-time
 * property that a unit test of the exported helpers cannot observe, and the
 * failure mode is a hung page rather than a caught exception.
 */
const MODALS = [
  "src/components/portal/manager-communication-compose-modal.tsx",
  "src/components/portal/inbox-scoped-compose-modal.tsx",
];

describe("compose modal render stability", () => {
  it.each(MODALS)("%s takes no array/object literal as a default prop", (path) => {
    const src = readFileSync(path, "utf8");
    // Matches `foo = [],` / `foo = {},` in a destructured parameter list.
    const literalDefaults = src.match(/^\s+\w+ = (\[\]|\{\}),$/gm) ?? [];
    expect(literalDefaults).toEqual([]);
  });

  it.each(MODALS)("%s prunes selections without allocating every time", (path) => {
    const src = readFileSync(path, "utf8");
    // The unguarded shape: a setter whose body is a bare filter/merge call, with
    // no `return prev` bail-out for the unchanged case.
    const unguarded =
      src.match(/setSelected\w*\(\(prev\) => prev\.filter\([^)]*\)\);/g) ?? [];
    expect(unguarded).toEqual([]);

    // And every pruning effect must be able to hand `prev` back so React can
    // bail out on Object.is.
    const setterBlocks = src.match(/setSelected\w*\(\(prev\) => \{[\s\S]*?\n {4}\}\);/g) ?? [];
    expect(setterBlocks.length).toBeGreaterThan(0);
    for (const block of setterBlocks) {
      expect(block).toContain("prev : next");
    }
  });
});
