import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("public browse redirect", () => {
  it("redirects legacy /browse to /rent/browse", () => {
    const config = readFileSync(join(process.cwd(), "next.config.ts"), "utf8");
    expect(config).toContain('source: "/browse", destination: "/rent/browse"');
  });
});
