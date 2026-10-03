import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// The email footer's sender name comes from the request (display only): it must be escaped.
describe("inbox email footer escapes the sender name", () => {
  for (const file of ["src/app/api/portal/send-inbox-message/route.ts", "src/lib/portal-inbox-delivery.ts"]) {
    it(file, () => {
      const src = readFileSync(file, "utf8");
      expect(src).not.toContain("Sent via PropLane portal by ${fromName}</p>");
      expect(src).toMatch(/Sent via PropLane portal by \$\{String\(fromName\)\.replace\(\/&\/g/);
    });
  }
});
