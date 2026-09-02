import { describe, expect, it } from "vitest";

import {
  MAX_AGENT_CUSTOM_INSTRUCTIONS,
  loadAgentCustomInstructions,
  parseAgentCustomInstructions,
  saveAgentCustomInstructions,
  withAgentCustomInstructions,
} from "@/lib/agent/user-preferences";
import { LEASING_SMS_AGENT_SYSTEM_PROMPT } from "@/lib/agent/system-prompts";
import { leasingSmsSystemPromptForWorkNumberOwner } from "@/lib/agent/leasing-sms-custom-instructions";

type PreferenceRow = { user_id: string; custom_instructions: string; updated_at?: string };

function makePreferenceDb(rows: PreferenceRow[] = []) {
  return {
    from(table: string) {
      if (table !== "agent_user_preferences") throw new Error(`Unexpected table: ${table}`);
      let userId = "";
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = (_column: string, value: string) => {
        userId = value;
        return chain;
      };
      chain.maybeSingle = async () => ({
        data: rows.find((row) => row.user_id === userId) ?? null,
        error: null,
      });
      chain.delete = () => ({
        eq: async (_column: string, value: string) => {
          const index = rows.findIndex((row) => row.user_id === value);
          if (index >= 0) rows.splice(index, 1);
          return { error: null };
        },
      });
      chain.upsert = async (value: PreferenceRow) => {
        const index = rows.findIndex((row) => row.user_id === value.user_id);
        if (index >= 0) rows[index] = value;
        else rows.push(value);
        return { error: null };
      };
      return chain;
    },
    // The production helper accepts the service client at this deliberate boundary.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

describe("assistant custom instructions", () => {
  it("accepts trimmed text and rejects invalid or oversized payloads", () => {
    expect(parseAgentCustomInstructions("  Keep it friendly.  ")).toEqual({ ok: true, value: "Keep it friendly." });
    expect(parseAgentCustomInstructions("\u0000")).toEqual({ ok: true, value: null });
    expect(parseAgentCustomInstructions({ text: "nope" })).toMatchObject({ ok: false });
    expect(parseAgentCustomInstructions("x".repeat(MAX_AGENT_CUSTOM_INSTRUCTIONS + 1))).toMatchObject({ ok: false });
  });

  it("keeps records private to each user and clears only the requesting user's record", async () => {
    const db = makePreferenceDb();
    await saveAgentCustomInstructions(db, "manager-a", "Use a warm tone.");
    await saveAgentCustomInstructions(db, "resident-b", "Be concise.");

    expect(await loadAgentCustomInstructions(db, "manager-a")).toBe("Use a warm tone.");
    expect(await loadAgentCustomInstructions(db, "resident-b")).toBe("Be concise.");
    expect(await loadAgentCustomInstructions(db, "vendor-c")).toBeNull();

    await saveAgentCustomInstructions(db, "manager-a", null);
    expect(await loadAgentCustomInstructions(db, "manager-a")).toBeNull();
    expect(await loadAgentCustomInstructions(db, "resident-b")).toBe("Be concise.");
  });

  it("adds preferences as low-priority, task-relevant guidance without weakening safety rules", () => {
    const base = "Platform rules: use tools for facts and require confirmation for writes.";
    const prompt = withAgentCustomInstructions(base, "End relevant resident drafts with: Yo, thanks for rooming with me.");

    expect(prompt).toContain(base);
    expect(prompt).toContain("Yo, thanks for rooming with me.");
    expect(prompt).toMatch(/only when relevant to the task and recipient/i);
    expect(prompt).toMatch(/never override tool scope, factual grounding, privacy/i);
    expect(withAgentCustomInstructions(base, "")).toBe(base);
  });

  it("loads the work-number owner's instructions, not another user's, for leasing SMS", async () => {
    const db = makePreferenceDb([
      { user_id: "work-number-owner", custom_instructions: "Sign prospect replies with - Jordan." },
      { user_id: "different-manager", custom_instructions: "Never include this." },
    ]);
    const prompt = await leasingSmsSystemPromptForWorkNumberOwner(db, "work-number-owner");
    expect(prompt).toContain(LEASING_SMS_AGENT_SYSTEM_PROMPT);
    expect(prompt).toContain("Sign prospect replies with - Jordan.");
    expect(prompt).not.toContain("Never include this.");
    // The base SMS guardrails remain before the user preference block.
    expect(prompt.indexOf("ONLY from tool results")).toBeLessThan(prompt.indexOf("Sign prospect replies with - Jordan."));
  });
});
