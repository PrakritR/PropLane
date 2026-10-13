import { describe, expect, it } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";
import {
  allocateAssistantMailboxLocal,
  workspaceMailboxLocalFor,
} from "@/lib/manager-assistant-email/assistant-mailbox-local.server";
import { RESERVED_MAILBOX_LOCALS } from "@/lib/manager-assistant-email/assistant-email-address";
import { RESERVED } from "@/lib/manager-assistant-email/workspace-mailbox-local-rule.mjs";
// @ts-expect-error plain-JS script, no types
import { pickLocal, planRenames } from "../../scripts/backfill-workspace-mailbox-locals.mjs";

const profile = { fullName: "Prakrit Ramachandran", email: "p@example.com" };

describe("workspaceMailboxLocalFor", () => {
  it("compacts the workspace name to letters and digits", () => {
    expect(workspaceMailboxLocalFor("SEATTLE HOMES", "Prakrit")).toBe("seattlehomes");
    expect(workspaceMailboxLocalFor("My workspace", "Prakrit")).toBe("myworkspace");
    expect(workspaceMailboxLocalFor("Ida Cares Homes #2", "")).toBe("idacareshomes2");
  });
  it("appends the owner's first name when the slug is too short or reserved", () => {
    expect(workspaceMailboxLocalFor("AB", "Maya")).toBe("abmaya");
    expect(workspaceMailboxLocalFor("Team", "Maya")).toBe("teammaya");
    expect(workspaceMailboxLocalFor("Support", "Maya")).toBe("supportmaya");
  });
  it("never hands out a brand or payment name", () => {
    expect(workspaceMailboxLocalFor("Stripe", "Maya")).toBe("stripemaya");
  });
  it("returns empty when nothing usable can be derived", () => {
    expect(workspaceMailboxLocalFor("", "")).toBe("");
    expect(workspaceMailboxLocalFor("--", "")).toBe("");
  });
  it("keeps the script's reserved list in step with the app's", () => {
    expect(new Set(RESERVED)).toEqual(new Set(RESERVED_MAILBOX_LOCALS));
  });
});

describe("allocateAssistantMailboxLocal", () => {
  it("takes the workspace slug first, never assist-<person>", async () => {
    const db = createMemoryDb({ manager_assistant_emails: [] });
    await expect(allocateAssistantMailboxLocal(db as never, profile, "tok123456789", "Seattle Homes")).resolves.toBe("seattlehomes");
  });
  it("suffixes -2 on a collision", async () => {
    const db = createMemoryDb({ manager_assistant_emails: [{ manager_user_id: "x", mailbox_local: "seattlehomes", provision_state: "active" }] });
    const local = await allocateAssistantMailboxLocal(db as never, profile, undefined, "Seattle Homes");
    expect(local).toBe("seattlehomes-2");
  });
  it("falls back to the owner's first name for a short name", async () => {
    const db = createMemoryDb({ manager_assistant_emails: [] });
    await expect(allocateAssistantMailboxLocal(db as never, profile, undefined, "HQ")).resolves.toBe("hqprakrit");
  });
});

describe("backfill plan (dry run)", () => {
  const row = (over: Record<string, unknown>) => ({
    id: "e1", workspaceId: "w1", ownerId: "o1", mailboxLocal: "assist-prakrit", workspaceName: "Seattle Homes", ownerFirst: "Prakrit", ...over,
  });
  it("renames a row off the rule and prints old -> new", () => {
    const plans = planRenames([row({})]);
    expect(plans.map((p: { workspaceName: string; mailboxLocal: string; next: string }) => `${p.workspaceName}: ${p.mailboxLocal} -> ${p.next}`)).toEqual([
      "Seattle Homes: assist-prakrit -> seattlehomes",
    ]);
  });
  it("is idempotent: rows already on the rule (or its -N suffix) are untouched", () => {
    expect(planRenames([row({ mailboxLocal: "seattlehomes" })])).toEqual([]);
    expect(planRenames([row({ mailboxLocal: "seattlehomes-3" })])).toEqual([]);
  });
  it("suffixes when another workspace holds the name, and respects another owner's live alias", () => {
    const plans = planRenames(
      [row({}), row({ id: "e2", workspaceId: "w2", ownerId: "o2", mailboxLocal: "seattlehomes", workspaceName: "Seattle Homes" })],
      new Map(),
    );
    expect(plans).toHaveLength(1);
    expect(plans[0].next).toBe("seattlehomes-2");
    expect(pickLocal("a1b", new Set(["a1b"]))).toBe("a1b-2");
    const aliased = planRenames([row({})], new Map([["seattlehomes", "someone-else"]]));
    expect(aliased[0].next).toBe("seattlehomes-2");
  });
  it("never hands a local one workspace was renamed off to another workspace in the same run", () => {
    // Applying the first plan holds `seattlehomes` as o1's 30-day alias, and an ACTIVE row wins over an
    // alias on inbound mail: handing it to o2 here would route o1's grace-period mail into o2.
    const plans = planRenames([
      row({ id: "e1", ownerId: "o1", mailboxLocal: "seattlehomes", workspaceName: "Alpha Rentals", ownerFirst: "Ann" }),
      row({ id: "e2", workspaceId: "w2", ownerId: "o2", mailboxLocal: "assist-bob", workspaceName: "Seattle Homes", ownerFirst: "Bob" }),
    ]);
    expect(plans.map((p: { id: string; next: string }) => [p.id, p.next])).toEqual([
      ["e1", "alpharentals"],
      ["e2", "seattlehomes-2"],
    ]);
  });
});
