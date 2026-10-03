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

// S12 (comms-safety-0929): the sender name is the authenticated account's own,
// not a string the request body supplies - a body-supplied name let any account
// send as "PropLane Support".
describe("the send route takes the sender name from the account, not the body", () => {
  it("never reads body.fromName for the display name", () => {
    const src = readFileSync("src/app/api/portal/send-inbox-message/route.ts", "utf8");
    expect(src).not.toMatch(/=\s*String\(body\.fromName/);
    expect(src).toMatch(/from\("profiles"\)\.select\("full_name"\)\.eq\("id", user\.id\)/);
  });
});
