import { afterEach, describe, expect, it, vi } from "vitest";
const actor = vi.hoisted(() => vi.fn());
vi.mock("server-only", () => ({}));
vi.mock("@/lib/resident-identity/auth.server", () => ({ residentIdentityActor: actor }));
vi.mock("@/lib/resident-identity/persona.server", () => ({ personaEnabled: () => false }));
import { resolveResidentEvidencePolicy } from "@/lib/resident-evidence/policy.server";
const env = { ...process.env };
afterEach(() => { process.env = { ...env }; actor.mockReset(); });
describe("evidence resolver boundary", () => {
  it("does not touch authentication or storage when rollout is off", async () => {
    delete process.env.RESIDENT_EVIDENCE_ENABLED;
    expect(await resolveResidentEvidencePolicy("home", "tour")).toEqual({ kind: "disabled" });
    expect(actor).not.toHaveBeenCalled();
  });
  it("requires a server-authenticated resident when enabled", async () => {
    process.env.RESIDENT_EVIDENCE_ENABLED = "true";
    actor.mockResolvedValue(null);
    expect(await resolveResidentEvidencePolicy("home", "tour")).toEqual({ kind: "unavailable", reason: "authentication_required" });
  });
});
