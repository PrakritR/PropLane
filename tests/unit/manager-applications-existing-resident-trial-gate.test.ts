/**
 * Adding an existing resident through `POST /api/manager-applications` (the `existingResidentOnboarding`
 * branch) keeps the record write but sends no welcome email / text while the workspace owner is on a
 * live signup trial. The route is too entangled to drive end to end, so this pins the wiring in
 * source; the verdict and the skip-with-flag behaviour are driven in
 * `manager-welcome-invite-trial-gate.test.ts` (same helper, same shape on `onboard-existing-resident`).
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync("src/app/api/manager-applications/route.ts", "utf8");
const branch = source.slice(source.indexOf("body.existingResidentOnboarding) {"));

describe("manager-applications existingResidentOnboarding - trial gate wiring", () => {
  it("asks the active workspace owner's plan before onboarding", () => {
    const gate = branch.indexOf("assertManagerCommunicationAllowedForActiveWorkspace(");
    const run = branch.indexOf("runExistingResidentOnboarding(");
    expect(gate).toBeGreaterThan(-1);
    expect(run).toBeGreaterThan(gate);
  });

  it("only consults the plan when a welcome was asked for, and records the reason", () => {
    expect(branch).toMatch(/sendWelcomeEmail !== false\)\s*\{\s*const communication = await assertManagerCommunicationAllowedForActiveWorkspace/);
    expect(branch).toContain("communicationBlocked = communication.reason");
  });

  it("turns the welcome off and reports it, without failing the save", () => {
    expect(branch).toContain("sendWelcomeEmail !== false && !communicationBlocked");
    expect(branch).toMatch(/\.\.\.\(communicationBlocked \? \{ communicationBlocked \} : \{\}\)/);
    expect(branch).not.toMatch(/communicationBlocked[^\n]*status:\s*40[23]/);
  });
});
