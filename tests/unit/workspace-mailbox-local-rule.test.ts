import { describe, expect, it } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";
import {
  allocateAssistantMailboxLocal,
  workspaceMailboxLocalFor,
} from "@/lib/manager-assistant-email/assistant-mailbox-local.server";
import { RESERVED_MAILBOX_LOCALS } from "@/lib/manager-assistant-email/assistant-email-address";
import {
  RESERVED,
  mailboxLocalIsDerivedFrom,
  serviceWorkspaceMailboxLocalFor,
} from "@/lib/manager-assistant-email/workspace-mailbox-local-rule.mjs";
// @ts-expect-error plain-JS script, no types
import { formatServicePlan, isProductionSupabaseUrl, pickLocal, planRenames, planServiceEmails } from "../../scripts/backfill-workspace-mailbox-locals.mjs";

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

describe("serviceWorkspaceMailboxLocalFor", () => {
  it("names a managed workspace after the client plus homes", () => {
    expect(serviceWorkspaceMailboxLocalFor("1. Ambika", "Prakrit")).toBe("ambikahomes");
    expect(serviceWorkspaceMailboxLocalFor("2. Vinod", "Prakrit")).toBe("vinodhomes");
    expect(serviceWorkspaceMailboxLocalFor("12) Lake View", "Prakrit")).toBe("lakeviewhomes");
    expect(serviceWorkspaceMailboxLocalFor("#3 - Birch", "Prakrit")).toBe("birchhomes");
  });
  it("does not double the suffix", () => {
    expect(serviceWorkspaceMailboxLocalFor("Seattle Homes", "Prakrit")).toBe("seattlehomes");
    expect(serviceWorkspaceMailboxLocalFor("4. Ida Cares Homes", "")).toBe("idacareshomes");
  });
  it("never lets a reserved or brand word through on its own", () => {
    expect(serviceWorkspaceMailboxLocalFor("Support", "Maya")).toBe("supporthomes");
    expect(serviceWorkspaceMailboxLocalFor("1. Stripe", "Maya")).toBe("stripehomes");
  });
  it("falls back to the self-serve rule when the name has no letters or is too long", () => {
    expect(serviceWorkspaceMailboxLocalFor("123", "Maya")).toBe(workspaceMailboxLocalFor("123", "Maya"));
    expect(serviceWorkspaceMailboxLocalFor("1. 42", "Maya")).toBe(workspaceMailboxLocalFor("1. 42", "Maya"));
    const long = "A".repeat(40);
    expect(serviceWorkspaceMailboxLocalFor(long, "Maya")).toBe(workspaceMailboxLocalFor(long, "Maya"));
    expect(serviceWorkspaceMailboxLocalFor("", "")).toBe("");
  });
  it("leaves the self-serve outputs unchanged", () => {
    expect(workspaceMailboxLocalFor("SEATTLE HOMES", "Prakrit")).toBe("seattlehomes");
    expect(workspaceMailboxLocalFor("My workspace", "Prakrit")).toBe("myworkspace");
    expect(workspaceMailboxLocalFor("Ida Cares Homes #2", "")).toBe("idacareshomes2");
    expect(workspaceMailboxLocalFor("1. Ambika", "Prakrit")).toBe("1ambika");
  });
});

describe("mailboxLocalIsDerivedFrom", () => {
  it("is true for the rule's output (either rule, with or without a collision suffix) and false once customized", () => {
    expect(mailboxLocalIsDerivedFrom("1. Ambika", "P", "ambikahomes")).toBe(true);
    expect(mailboxLocalIsDerivedFrom("1. Ambika", "P", "ambikahomes-2")).toBe(true);
    expect(mailboxLocalIsDerivedFrom("1. Ambika", "P", "1ambika")).toBe(true);
    expect(mailboxLocalIsDerivedFrom("1. Ambika", "P", "frontdesk")).toBe(false);
    expect(mailboxLocalIsDerivedFrom("1. Ambika", "P", "ambikahomes-x7k2")).toBe(true);
    expect(mailboxLocalIsDerivedFrom("1. Ambika", "P", "ambikahomes-12")).toBe(false);
    expect(mailboxLocalIsDerivedFrom("1. Ambika", "P", "")).toBe(false);
  });
});

describe("backfill --service plan (dry run)", () => {
  const ws = (over: Record<string, unknown>) => ({
    workspaceId: "w1", workspaceName: "1. Ambika", ownerId: "o1", ownerFirst: "Prakrit", email: null, ...over,
  });
  it("mints for a workspace with no address and renames one off the service rule", () => {
    const plans = planServiceEmails([
      ws({}),
      ws({ workspaceId: "w2", workspaceName: "2. Vinod", email: { id: "e2", mailboxLocal: "vinod" } }),
    ]);
    expect(plans.map((p: { kind: string; workspaceName: string; mailboxLocal: string | null; next: string }) => `${p.kind} ${p.workspaceName}: ${p.mailboxLocal} -> ${p.next}`)).toEqual([
      "mint 1. Ambika: null -> ambikahomes",
      "rename 2. Vinod: vinod -> vinodhomes",
    ]);
  });
  it("is idempotent and leaves a suffixed rule output alone", () => {
    expect(planServiceEmails([ws({ email: { id: "e1", mailboxLocal: "ambikahomes" } })])).toEqual([]);
    expect(planServiceEmails([ws({ email: { id: "e1", mailboxLocal: "ambikahomes-2" } })])).toEqual([]);
  });
  it("suffixes on a collision with another holder or another owner's live alias", () => {
    const held = [{ workspaceId: "other:1", workspaceName: "", ownerId: "other:1", ownerFirst: "", email: { id: "x", mailboxLocal: "ambikahomes" } }];
    expect(planServiceEmails([ws({}), ...held])[0].next).toBe("ambikahomes-2");
    expect(planServiceEmails([ws({})], new Map([["ambikahomes", "someone-else"]]))[0].next).toBe("ambikahomes-2");
  });
  it("prints a table with the workspace id, name, current and new", () => {
    const table = formatServicePlan(planServiceEmails([ws({})]));
    expect(table.split("\n")[0]).toMatch(/workspace id\s+name\s+current\s+new/);
    expect(table).toMatch(/w1\s+1\. Ambika\s+\(none\)\s+ambikahomes/);
  });
  it("recognizes the production project so the script can refuse it", () => {
    expect(isProductionSupabaseUrl("https://qahnczmilgptcedaqype.supabase.co")).toBe(true);
    expect(isProductionSupabaseUrl("https://emstjswhotsnyksqhqyf.supabase.co")).toBe(false);
  });
});
