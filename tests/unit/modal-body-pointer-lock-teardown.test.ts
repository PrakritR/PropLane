// The stale-body-pointer-lock sweep runs on a 200ms timer, which can outlive the
// document it was scheduled for (a torn-down test environment, a navigated
// frame). Reading `document` unguarded inside the callback threw an uncaught
// ReferenceError that failed the whole unit run.
import { afterEach, describe, expect, it } from "vitest";

import { clearStaleBodyPointerLock } from "@/components/ui/modal";

type Globals = typeof globalThis & { document?: unknown; window?: unknown };

const globals = globalThis as Globals;

afterEach(() => {
  delete globals.document;
  delete globals.window;
});

describe("clearStaleBodyPointerLock", () => {
  it("survives the document disappearing before its timers fire", async () => {
    globals.document = {
      body: { style: { pointerEvents: "none" } },
      querySelector: () => null,
    };
    globals.window = { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms) };

    clearStaleBodyPointerLock();
    delete globals.document;

    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(globals.document).toBeUndefined();
  });
});
