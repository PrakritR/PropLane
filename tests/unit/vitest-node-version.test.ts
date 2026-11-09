import { describe, expect, it } from "vitest";
import { assertVitestNodeVersion } from "../setup/assert-vitest-node";

describe("Vitest runtime guard", () => {
  it("accepts Node 22", () => expect(() => assertVitestNodeVersion("22.23.4")).not.toThrow());
  it.each(["20.19.0", "24.0.0", "26.4.0", "invalid"])("refuses %s with an actionable message", (version) => {
    expect(() => assertVitestNodeVersion(version)).toThrow(/Vitest requires Node 22.*Select Node 22/);
  });
});
