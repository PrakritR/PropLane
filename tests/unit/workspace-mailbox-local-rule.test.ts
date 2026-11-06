import { describe, expect, it } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";
import {
  allocateAssistantMailboxLocal,
  workspaceMailboxLocalFor,
} from "@/lib/manager-assistant-email/assistant-mailbox-local.server";
import { RESERVED_MAILBOX_LOCALS } from "@/lib/manager-assistant-email/assistant-email-address";
import {
  RESERVED,
  localFollowsBase,
  mailboxLocalIsDerivedFrom,
  serviceWorkspaceMailboxLocalFor,
} from "@/lib/manager-assistant-email/workspace-mailbox-local-rule.mjs";
// @ts-expect-error plain-JS script, no types
import { aliasHolders, formatServicePlan, isProductionSupabaseUrl, parseRenameWorkspaceIds, pickLocal, planRenames, planServiceEmails } from "../../scripts/backfill-workspace-mailbox-locals.mjs";

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

  it("builds the token collision suffix from letters and digits only, so the rule still recognizes it", async () => {
    // The token is base64url: a raw slice could emit `seattlehomes-a-b1`, which `localFollowsBase` misses, and a
    // later rename then refused to follow the workspace's new name because PropLane's own address read customized.
    const db = createMemoryDb({ manager_assistant_emails: [{ manager_user_id: "x", mailbox_local: "seattlehomes", provision_state: "active" }] });
    const local = await allocateAssistantMailboxLocal(db as never, profile, "a-b1_cd9", "Seattle Homes");
    expect(local).toBe("seattlehomes-ab1c");
    expect(localFollowsBase(local, "seattlehomes")).toBe(true);
    expect(mailboxLocalIsDerivedFrom("Seattle Homes", "Prakrit", local)).toBe(true);
  });

  it("skips the token candidate when the token has fewer than four usable characters", async () => {
    const db = createMemoryDb({ manager_assistant_emails: [{ manager_user_id: "x", mailbox_local: "seattlehomes", provision_state: "active" }] });
    await expect(allocateAssistantMailboxLocal(db as never, profile, "a-_", "Seattle Homes")).resolves.toBe("seattlehomes-2");
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
  it("strips the ordinal in linear time on a whitespace-only name", () => {
    // A workspace name reaches this rule straight from a request body. The earlier ordinal pattern was
    // `^\s*#?\s*\d+...`: two repetitions competing for the same whitespace, so a name of pure tabs backtracked
    // quadratically (~0.2s at 20k tabs, ~20s at 200k). The current pattern makes `#` mandatory inside its own
    // group, so there is only one way to consume the whitespace.
    const started = Date.now();
    expect(serviceWorkspaceMailboxLocalFor("\t".repeat(200_000), "Maya")).toBe("maya");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
  it("leaves the self-serve outputs unchanged", () => {
    expect(workspaceMailboxLocalFor("SEATTLE HOMES", "Prakrit")).toBe("seattlehomes");
    expect(workspaceMailboxLocalFor("My workspace", "Prakrit")).toBe("myworkspace");
    expect(workspaceMailboxLocalFor("Ida Cares Homes #2", "")).toBe("idacareshomes2");
    expect(workspaceMailboxLocalFor("1. Ambika", "Prakrit")).toBe("1ambika");
  });
});

describe("mailboxLocalIsDerivedFrom", () => {
  it("is true for the SERVICE rule's output (with or without a collision suffix) and false once customized", () => {
    expect(mailboxLocalIsDerivedFrom("1. Ambika", "P", "ambikahomes")).toBe(true);
    expect(mailboxLocalIsDerivedFrom("1. Ambika", "P", "ambikahomes-2")).toBe(true);
    expect(mailboxLocalIsDerivedFrom("1. Ambika", "P", "frontdesk")).toBe(false);
    expect(mailboxLocalIsDerivedFrom("1. Ambika", "P", "ambikahomes-x7k2")).toBe(true);
    expect(mailboxLocalIsDerivedFrom("1. Ambika", "P", "ambikahomes-12")).toBe(false);
    expect(mailboxLocalIsDerivedFrom("1. Ambika", "P", "")).toBe(false);
  });

  it("does NOT claim a self-serve-derived address: that one was published before PropLane took over", () => {
    // `ensureOwnedWorkspaceAssistantEmails` mints `{workspace-slug}@` for a self-serve workspace. Reading it as
    // "never customized" let a rename move a live, published address and bounce replies after the alias lapsed.
    expect(workspaceMailboxLocalFor("1. Ambika", "P")).toBe("1ambika");
    expect(mailboxLocalIsDerivedFrom("1. Ambika", "P", "1ambika")).toBe(false);
    expect(mailboxLocalIsDerivedFrom("Seattle Rentals", "P", "seattlerentals")).toBe(false);
  });
});

describe("backfill --service plan (dry run)", () => {
  const ws = (over: Record<string, unknown>) => ({
    workspaceId: "w1", workspaceName: "1. Ambika", ownerId: "o1", ownerFirst: "Prakrit", email: null, ...over,
  });
  const described = (plans: { kind: string; workspaceName: string; mailboxLocal: string | null; next: string }[]) =>
    plans.map((p) => `${p.kind} ${p.workspaceName}: ${p.mailboxLocal} -> ${p.next}`);

  it("mints for a workspace with no address and leaves a workspace that has one alone", () => {
    const rows = [ws({}), ws({ workspaceId: "w2", workspaceName: "2. Vinod", email: { id: "e2", mailboxLocal: "vinod" } })];
    expect(described(planServiceEmails(rows))).toEqual(["mint 1. Ambika: null -> ambikahomes"]);
    // Named explicitly, that second workspace moves onto its service-rule local.
    expect(described(planServiceEmails(rows, new Map(), new Set(["w2"])))).toEqual([
      "mint 1. Ambika: null -> ambikahomes",
      "rename 2. Vinod: vinod -> vinodhomes",
    ]);
  });
  it("is idempotent and leaves a suffixed rule output alone", () => {
    expect(planServiceEmails([ws({ email: { id: "e1", mailboxLocal: "ambikahomes" } })])).toEqual([]);
    expect(planServiceEmails([ws({ email: { id: "e1", mailboxLocal: "ambikahomes-2" } })])).toEqual([]);
  });

  it("is MINT-ONLY: an address the workspace already holds is never moved without the explicit opt-in", () => {
    // Same invariant `attachWorkspaceToService` keeps: `seattlerentals@` may be on listings and in the public
    // listing payload, and retiring it behind a 30-day alias bounces replies once the alias lapses.
    const selfServe = ws({ workspaceName: "2. Vinod", email: { id: "e2", mailboxLocal: "seattlerentals" } });
    expect(planServiceEmails([selfServe])).toEqual([]);
    expect(planServiceEmails([ws({ email: { id: "e1", mailboxLocal: "frontdesk" } })])).toEqual([]);
    // A workspace with no address at all is still minted in the same run.
    expect(planServiceEmails([selfServe, ws({ workspaceId: "w3", workspaceName: "3. Birch" })]).map((p) => `${p.kind} ${p.next}`)).toEqual([
      "mint birchhomes",
    ]);
  });

  it("--rename-workspace moves that one workspace, and only that one", () => {
    const rows = [
      ws({ workspaceName: "2. Vinod", email: { id: "e2", mailboxLocal: "seattlerentals" } }),
      ws({ workspaceId: "w3", workspaceName: "3. Birch", email: { id: "e3", mailboxLocal: "birchwood" } }),
    ];
    const plans = planServiceEmails(rows, new Map(), new Set(["w1"]));
    expect(plans.map((p: { kind: string; workspaceId: string; mailboxLocal: string; next: string }) => `${p.kind} ${p.workspaceId}: ${p.mailboxLocal} -> ${p.next}`)).toEqual([
      "rename w1: seattlerentals -> vinodhomes",
    ]);
  });
  it("suffixes on a collision with another holder or another owner's live alias", () => {
    const held = [{ workspaceId: "other:1", workspaceName: "", ownerId: "other:1", ownerFirst: "", email: { id: "x", mailboxLocal: "ambikahomes" } }];
    expect(planServiceEmails([ws({}), ...held])[0].next).toBe("ambikahomes-2");
    expect(planServiceEmails([ws({})], new Map([["ambikahomes", "someone-else"]]))[0].next).toBe("ambikahomes-2");
  });
  it("a live alias is held by its WORKSPACE: a sibling under the same owner user cannot take it", () => {
    const aliases = aliasHolders(
      [
        { mailbox_local: "ambikahomes", assistant_email_id: "e1", expires_at: new Date(Date.now() + 1e6).toISOString() },
        { mailbox_local: "orphan", assistant_email_id: "gone", expires_at: new Date(Date.now() + 1e6).toISOString() },
        { mailbox_local: "stale", assistant_email_id: "e1", expires_at: new Date(Date.now() - 1e6).toISOString() },
      ],
      [{ id: "e1", workspace_id: "w-a" }],
    );
    expect([...aliases.keys()].sort()).toEqual(["ambikahomes", "orphan"]);
    const sibling = { workspaceId: "w-b", workspaceName: "1. Ambika", ownerId: "shared-owner", ownerFirst: "", email: null };
    expect(planServiceEmails([sibling], aliases)[0].next).toBe("ambikahomes-2");
    const holder = { ...sibling, workspaceId: "w-a" };
    expect(planServiceEmails([holder], aliases)[0].next).toBe("ambikahomes");
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

describe("--rename-workspace parsing", () => {
  const WS = "11111111-2222-4333-8444-555555555555";
  const WS2 = "66666666-7777-4888-8999-aaaaaaaaaaaa";

  it("accepts both the spaced and the = form, and is repeatable", () => {
    expect([...parseRenameWorkspaceIds(["--service", "--rename-workspace", WS])]).toEqual([WS]);
    expect([...parseRenameWorkspaceIds(["--service", `--rename-workspace=${WS}`])]).toEqual([WS]);
    expect([...parseRenameWorkspaceIds([`--rename-workspace=${WS}`, "--rename-workspace", WS2, "--apply"])]).toEqual([WS, WS2]);
    expect([...parseRenameWorkspaceIds(["--service", "--apply"])]).toEqual([]);
  });

  it("does not swallow the next flag as the id", () => {
    // `--rename-workspace --apply` used to take "--apply" as the workspace id while --apply still registered.
    expect(() => parseRenameWorkspaceIds(["--rename-workspace", "--apply"])).toThrow(/needs a workspace id/);
    expect(() => parseRenameWorkspaceIds(["--rename-workspace"])).toThrow(/needs a workspace id/);
    expect(() => parseRenameWorkspaceIds(["--rename-workspace="])).toThrow(/needs a workspace id/);
  });

  it("refuses a value that is not a workspace id instead of running mint-only in silence", () => {
    expect(() => parseRenameWorkspaceIds(["--rename-workspace=w1"])).toThrow(/not a workspace id/);
    expect(() => parseRenameWorkspaceIds(["--rename-workspace", "ambika"])).toThrow(/not a workspace id/);
  });

  it("normalizes case, so an id pasted from a console matches the stored row", () => {
    expect([...parseRenameWorkspaceIds([`--rename-workspace=${WS.toUpperCase()}`])]).toEqual([WS]);
  });
});
