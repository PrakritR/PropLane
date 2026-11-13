import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("requireManagedOwner session read", () => {
  const src = readFileSync("src/lib/managed-finance/routes.server.ts", "utf8");
  it("reads the session through the route actor, so an auth-service failure is a 503, never a 401", () => {
    expect(src).toContain("resolveRouteSessionUser");
    expect(src).not.toContain("auth.auth.getUser()");
  });
  it("an unreadable business-access check is a 503, not an unhandled 500 or a 401", () => {
    expect(src).toMatch(/catch \{\s*return NextResponse\.json\(\{ error: "PropLane could not check your sign-in\. Try again\." \}, \{ status: 503 \}\)/);
  });
});
