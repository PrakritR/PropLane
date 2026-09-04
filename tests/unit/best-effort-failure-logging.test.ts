import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { bestEffortFailed } from "@/lib/observability/best-effort";

/**
 * Best-effort is right for DELIVERY and wrong for KNOWING. A manager could
 * receive no notice that an application had been submitted, with no trace
 * anywhere, while the applicant saw a success screen and reasonably concluded
 * they were ignored (PRP-209). `.catch(() => undefined)` reads as deliberate,
 * so nobody revisits it.
 */
afterEach(() => vi.restoreAllMocks());

describe("bestEffortFailed", () => {
  it("logs what failed, with context, and does not rethrow", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() =>
      bestEffortFailed("manager application-submitted notice", { application: "AXIS-1" })(
        new Error("smtp down"),
      ),
    ).not.toThrow();
    const logged = error.mock.calls.flat().join(" ");
    expect(logged).toContain("manager application-submitted notice");
    expect(logged).toContain("application=AXIS-1");
    expect(logged).toContain("smtp down");
  });

  it("survives a non-Error rejection", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    bestEffortFailed("something")("just a string");
    expect(error.mock.calls.flat().join(" ")).toContain("just a string");
  });

  it("omits empty context rather than logging key=", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    bestEffortFailed("x", { a: "1", b: null, c: undefined, d: "" })(new Error("e"));
    const logged = error.mock.calls.flat().join(" ");
    expect(logged).toContain("a=1");
    expect(logged).not.toContain("b=");
    expect(logged).not.toContain("c=");
    expect(logged).not.toContain("d=");
  });
});

describe("the paths someone is waiting on no longer discard failures", () => {
  const FILES = [
    "src/app/api/manager-applications/route.ts",
    "src/app/api/pro/account-links/route.ts",
    "src/app/api/pro/account-links/[inviteId]/route.ts",
  ];

  it("no notify or lifecycle-sync call swallows its rejection", () => {
    const offenders: string[] = [];
    for (const file of FILES) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      for (const match of source.matchAll(
        /(notifyManagerApplicationSubmitted|syncApplicationLifecycleTasks|provisionApprovedResidentAccount)[^;]*?\.catch\(\(\) => undefined\)/gs,
      )) {
        offenders.push(`${file}: ${match[0].slice(0, 80).replace(/\s+/g, " ")}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("the invite notifications report rather than comment their silence", () => {
    for (const file of FILES.slice(1)) {
      const source = readFileSync(join(process.cwd(), file), "utf8");
      expect(source).toContain("bestEffortFailed(");
      expect(source).not.toContain("/* notification failure should not block");
    }
  });
});
