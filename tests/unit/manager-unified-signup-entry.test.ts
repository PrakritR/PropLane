import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(join(process.cwd(), p), "utf8");

/**
 * PRP-193 — manager signup must use one form and one API regardless of entry URL.
 */
describe("PRP-193 unified manager signup entry", () => {
  const router = read("src/app/auth/create-account/create-account-router.tsx");
  const gateway = read("src/app/auth/create-account/create-account-role-gateway.tsx");
  const trialForm = read("src/components/auth/manager-trial-signup-form.tsx");

  it("routes the default create-account path through the role gateway", () => {
    expect(router).toContain("CreateAccountRoleGateway");
    expect(router).not.toMatch(/return <PortalAuthForm mode="create" variant="hub" \/>;/);
  });

  it("uses ManagerTrialSignupForm for role=manager in the gateway", () => {
    expect(gateway).toContain('role === "manager"');
    expect(gateway).toContain("ManagerTrialSignupForm");
  });

  it("asks for a role before hub signup when the URL has no role", () => {
    expect(gateway).toContain("AuthRoleStack");
    expect(gateway).toContain('variant="blend"');
    expect(gateway).toContain('params.set("role", nextRole)');
  });

  it("matches sign-in layout — no frosted auth card shell", () => {
    expect(gateway).toContain('variant="blend"');
    expect(gateway).toContain("native-auth-hub-stack");
    expect(gateway).not.toMatch(/<AuthCard>\s*\n/);
  });

  it("manager trial signup posts to manager-register only", () => {
    expect(trialForm).toContain('"/api/auth/manager-register"');
    expect(trialForm).not.toContain('"/api/auth/signup"');
  });
});
