/**
 * One work email per WORKSPACE — the email twin of workspace-work-number-routing.
 *
 * Every manager-role account used to request its own `assist-<name>@` address,
 * co-managers included, so one workspace answered from several identities and a
 * co-manager's mail left as an address nobody else on the team could see. Now
 * the address belongs to the workspace: a co-manager with no houses of their
 * own reads and sends from the owner's address, is never minted one, and a
 * legacy address they still hold answers for the owner's workspace.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";
import {
  ensureManagerAssistantEmail,
  resolveActiveManagerWorkEmail,
  resolveWorkspaceWorkEmail,
  resolveWorkspaceWorkEmails,
  WorkspaceEmailSharedError,
} from "@/lib/manager-assistant-email/manager-assistant-email.server";
import { resolveWorkspaceOwnerForWorkEmail } from "@/lib/sms/manager-workspace-role.server";
import { resolveManagerOutboundFrom } from "@/lib/manager-outbound-identity.server";

const owner = "owner", other = "other-owner", co = "co", solo = "solo";
const OWNER_ADDRESS = "assist-prakrit-ramachandran@prop-lane.space";

function seed(links: Record<string, unknown>[], extra: Record<string, Record<string, unknown>[]> = {}) {
  return createMemoryDb({
    profiles: [
      { id: owner, full_name: "Prakrit Ramachandran", email: "p@example.com", role: "manager" },
      { id: other, full_name: "", email: "maya@example.com", role: "manager" },
      { id: co, full_name: "Akhil", email: "a@example.com", role: "manager" },
      { id: solo, full_name: "Solo", email: "s@example.com", role: "manager" },
    ],
    profile_roles: [],
    manager_property_records: [
      { id: "house-a", manager_user_id: owner },
      { id: "house-b", manager_user_id: owner },
      { id: "house-c", manager_user_id: other },
    ],
    manager_assistant_emails: [
      {
        manager_user_id: owner,
        inbox_token: "tok000000001",
        mailbox_local: "assist-prakrit-ramachandran",
        provision_state: "active",
      },
    ],
    account_link_invites: links,
    ...extra,
  });
}

const accepted = (inviter: string, invitee: string, houses: string[]) => ({
  inviter_user_id: inviter,
  invitee_user_id: invitee,
  status: "accepted",
  assigned_property_ids: houses,
});

afterEach(() => vi.unstubAllEnvs());

describe("resolveWorkspaceWorkEmails — what an account reads and sends from", () => {
  it("an owner gets their own address", async () => {
    await expect(resolveWorkspaceWorkEmails(seed([]) as never, owner)).resolves.toEqual({
      role: "primary",
      emails: [{ ownerUserId: owner, ownerName: "Prakrit Ramachandran", address: OWNER_ADDRESS }],
    });
  });

  it("a co-manager gets the owner's address, named, and never one of their own", async () => {
    const db = seed([accepted(owner, co, ["house-a"])]);
    await expect(resolveWorkspaceWorkEmails(db as never, co)).resolves.toEqual({
      role: "co_manager",
      emails: [{ ownerUserId: owner, ownerName: "Prakrit Ramachandran", address: OWNER_ADDRESS }],
    });
    await expect(resolveWorkspaceWorkEmail(db as never, co)).resolves.toMatchObject({ address: OWNER_ADDRESS });
  });

  it("lists a workspace whose owner has not set one up, with a null address, so the UI can say whose job it is", async () => {
    const db = seed([accepted(other, co, ["house-c"])]);
    await expect(resolveWorkspaceWorkEmails(db as never, co)).resolves.toEqual({
      role: "co_manager",
      // No full name on file: the email stands in, exactly as the number does.
      emails: [{ ownerUserId: other, ownerName: "maya@example.com", address: null }],
    });
  });

  it("with several owners, the one with the most houses assigned comes first", async () => {
    const db = seed([accepted(owner, co, ["house-a"]), accepted(other, co, ["house-c", "house-d"])]);
    const { emails } = await resolveWorkspaceWorkEmails(db as never, co);
    expect(emails.map((e) => e.ownerUserId)).toEqual([other, owner]);
  });

  it("a manager with no accepted link owns their own (empty) workspace", async () => {
    const db = seed([{ ...accepted(owner, solo, ["house-a"]), status: "pending" }]);
    await expect(resolveWorkspaceWorkEmails(db as never, solo)).resolves.toEqual({
      role: "primary",
      emails: [{ ownerUserId: solo, ownerName: "Solo", address: null }],
    });
  });
});

describe("resolveWorkspaceOwnerForWorkEmail — whose workspace an address answers for", () => {
  it("a legacy co-manager address collapses to the owner whose houses they hold", async () => {
    const db = seed([accepted(owner, co, ["house-a", "house-b"])]);
    await expect(resolveWorkspaceOwnerForWorkEmail(db as never, co)).resolves.toEqual({
      ownerUserId: owner,
      sharedFromCoManager: true,
    });
  });

  it("an owner's own address answers for themselves", async () => {
    await expect(resolveWorkspaceOwnerForWorkEmail(seed([]) as never, owner)).resolves.toEqual({
      ownerUserId: owner,
      sharedFromCoManager: false,
    });
  });
});

describe("ensureManagerAssistantEmail — a co-manager is never minted an address", () => {
  it("refuses a pure co-manager at the write, not only in the route", async () => {
    const db = seed([accepted(owner, co, ["house-a"])]);
    await expect(ensureManagerAssistantEmail(db as never, co)).rejects.toBeInstanceOf(WorkspaceEmailSharedError);
    const { data } = await (db as never as { from: (t: string) => { select: () => Promise<{ data: unknown[] }> } })
      .from("manager_assistant_emails")
      .select();
    expect((data as { manager_user_id: string }[]).map((r) => r.manager_user_id)).toEqual([owner]);
  });

  it("still creates one for a manager with houses of their own", async () => {
    const db = seed([accepted(owner, other, ["house-a"])]);
    const row = await ensureManagerAssistantEmail(db as never, other);
    expect(row.address).toMatch(/^assist-maya@prop-lane\.space$/);
  });

  it("still creates one for a manager nobody has linked", async () => {
    const row = await ensureManagerAssistantEmail(seed([]) as never, solo);
    expect(row.address).toBe("assist-solo@prop-lane.space");
  });
});

describe("the address the rest of the product sees", () => {
  it("resolveActiveManagerWorkEmail hands a co-manager the workspace address", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    const db = seed([accepted(owner, co, ["house-a"])]);
    await expect(resolveActiveManagerWorkEmail(db as never, co)).resolves.toBe(OWNER_ADDRESS);
  });

  it("a legacy co-manager row never leaks its own address once it is shared", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    const db = seed([accepted(owner, co, ["house-a"])], {
      manager_assistant_emails: [
        { manager_user_id: owner, inbox_token: "tok000000001", mailbox_local: "assist-prakrit-ramachandran", provision_state: "active" },
        { manager_user_id: co, inbox_token: "tok000000002", mailbox_local: "assist-akhil", provision_state: "active" },
      ],
    });
    await expect(resolveActiveManagerWorkEmail(db as never, co)).resolves.toBe(OWNER_ADDRESS);
  });

  it("a co-manager's outbound mail carries THEIR name at the WORKSPACE address", async () => {
    const db = seed([accepted(owner, co, ["house-a"])]);
    await expect(resolveManagerOutboundFrom(db as never, co)).resolves.toBe(`Akhil <${OWNER_ADDRESS}>`);
  });

  it("an owner's outbound mail carries their own name at their own address", async () => {
    await expect(resolveManagerOutboundFrom(seed([]) as never, owner)).resolves.toBe(
      `Prakrit Ramachandran <${OWNER_ADDRESS}>`,
    );
  });

  it("falls back to the shared sender when the workspace has no address yet", async () => {
    const db = seed([accepted(other, co, ["house-c"])]);
    await expect(resolveManagerOutboundFrom(db as never, co)).resolves.toBeNull();
  });
});

describe("the inbound path collapses before it classifies", () => {
  it("resolves the workspace owner before claiming the message or reading the sender", () => {
    const source = readFileSync("src/lib/manager-assistant-email/process-assistant-inbound.server.ts", "utf8");
    const collapse = source.indexOf("resolveWorkspaceOwnerForWorkEmail(db, mailboxUserId)");
    const claim = source.indexOf("claimInboundEmail(db, parsed.emailId, managerUserId)");
    const classify = source.indexOf("classifyAssistantEmailSender(db, {");
    expect(collapse).toBeGreaterThan(-1);
    expect(collapse).toBeLessThan(claim);
    expect(claim).toBeLessThan(classify);
  });
});
