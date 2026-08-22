// Tour mail must never be posted to Resend for a sandbox address.
//
// `deliverEmail` in `tour-notification-delivery.server.ts` hand-rolled its own check and knew
// only `@axis.local`. The canonical test accounts are `@test.proplane.local` (AGENTS.md: the demo
// portfolio and the e2e runs both use them), so every tour confirmation sent during testing was a
// REAL send to a domain that does not resolve — a false "sent" signal, and a slow way to damage
// sender reputation.
//
// `shouldSkipOutboundEmail` is the one rule and already covered both domains. This pins the two
// halves: the shared predicate keeps covering both, and the tour sender keeps using it rather
// than growing its own copy again.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isPortalSandboxEmail, shouldSkipOutboundEmail } from "@/lib/portal-sandbox-accounts";

describe("sandbox address rule", () => {
  it("covers both sandbox domains", () => {
    expect(shouldSkipOutboundEmail("resident@test.proplane.local")).toBe(true);
    expect(shouldSkipOutboundEmail("someone@axis.local")).toBe(true);
    expect(isPortalSandboxEmail("RESIDENT@TEST.PROPLANE.LOCAL")).toBe(true);
  });

  it("does not swallow real addresses", () => {
    expect(shouldSkipOutboundEmail("maya@gmail.com")).toBe(false);
    expect(shouldSkipOutboundEmail("prakrit@prop-lane.space")).toBe(false);
    // A lookalike that merely CONTAINS the sandbox domain must still be delivered.
    expect(shouldSkipOutboundEmail("test.proplane.local@gmail.com")).toBe(false);
  });

  it("ignores blanks rather than treating them as sandbox", () => {
    expect(shouldSkipOutboundEmail("")).toBe(false);
    expect(shouldSkipOutboundEmail(null)).toBe(false);
    expect(shouldSkipOutboundEmail(undefined)).toBe(false);
  });
});

describe("tour notification delivery", () => {
  const SRC = readFileSync(
    join(process.cwd(), "src/lib/tour-notification-delivery.server.ts"),
    "utf8",
  );

  it("filters recipients through the shared rule, not a local copy", () => {
    expect(SRC).toContain("shouldSkipOutboundEmail");
    // The hand-rolled check is what missed `@test.proplane.local`; it must not come back.
    expect(SRC).not.toMatch(/endsWith\(["'`]@axis\.local["'`]\)/);
  });
});
