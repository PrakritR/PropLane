import { describe, expect, it } from "vitest";
import {
  propertyInAgentWorkspace,
  SWITCH_WORKSPACE_ASSISTANT_REPLY,
  withManagerWorkspacePrompt,
  type AgentWorkspaceScope,
} from "@/lib/agent/manager-workspace-scope";

const brooklyn: AgentWorkspaceScope = {
  id: "ws-brooklyn",
  name: "Brooklyn",
  isDefault: false,
  narrowing: true,
  propertyIds: ["house-a"],
};

describe("propertyInAgentWorkspace", () => {
  it("keeps houses in the active workspace and drops the rest", () => {
    expect(propertyInAgentWorkspace(brooklyn, "house-a")).toBe(true);
    expect(propertyInAgentWorkspace(brooklyn, "house-b")).toBe(false);
    expect(propertyInAgentWorkspace(undefined, "house-b")).toBe(true);
  });
});

describe("withManagerWorkspacePrompt", () => {
  it("tells the model the exact switch copy when the account is partitioned", () => {
    const system = withManagerWorkspacePrompt("You are PropLane Assistant.", brooklyn);
    expect(system).toContain("Brooklyn");
    expect(system).toContain(SWITCH_WORKSPACE_ASSISTANT_REPLY);
  });
});
