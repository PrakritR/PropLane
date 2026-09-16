/**
 * One work email per WORKSPACE — the email twin of workspace-work-number-routing.
 *
 * Every manager-role account used to request its own `assist-<name>@` address,
 * co-managers included, so one workspace answered from several identities and a
 * co-manager's mail left as an address nobody else on the team could see. Now
 * the address belongs to the workspace — a portal_workspaces row (the full
 * model is in workspace-work-identity.test.ts). This file pins the LEGACY
 * world the migration meets: rows with no workspace_id, accounts with no
 * workspace rows yet. An owner's unplaced address answers for their default
 * workspace; a pure co-manager's unplaced address collapses to the inviter;
 * and inside the workspace an owner shares, a co-manager sends from the
 * owner's address and is never minted one there.
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
    portal_workspaces: [
      { id: "ws-owner", owner_user_id: owner, name: "My workspace", is_default: true, created_at: "2026-01-01" },
      { id: "ws-other", owner_user_id: other, name: "My workspace", is_default: true, created_at: "2026-01-02" },
    ],
    manager_property_records: [
      { id: "house-a", manager_user_id: owner, workspace_id: "ws-owner", row_data: {} },
      { id: "house-b", manager_user_id: owner, workspace_id: "ws-owner", row_data: {} },
      { id: "house-c", manager_user_id: other, workspace_id: "ws-other", row_data: {} },
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
  property_co_manager_permissions: Object.fromEntries(houses.map((h) => [h, { inbox: true }])),
});

afterEach(() => vi.unstubAllEnvs());

describe("resolveWorkspaceWorkEmails — one entry per workspace the account can see", () => {
  it("an owner's unplaced legacy address answers for their default workspace", async () => {
    await expect(resolveWorkspaceWorkEmails(seed([]) as never, owner)).resolves.toEqual({
      role: "primary",
      emails: [
        expect.objectContaining({ workspaceId: "ws-owner", owned: true, ownerUserId: owner, ownerName: "Prakrit Ramachandran", address: OWNER_ADDRESS }),
      ],
    });
  });

  it("a co-manager sees their OWN empty workspace (no address) and the owner's, named — never one of their own in the owner's", async () => {
    const db = seed([accepted(owner, co, ["house-a"])]);
    const { role, emails } = await resolveWorkspaceWorkEmails(db as never, co);
    expect(role).toBe("co_manager");
    expect(emails).toEqual([
      expect.objectContaining({ owned: true, ownerUserId: co, address: null }),
      expect.objectContaining({ workspaceId: "ws-owner", owned: false, ownerUserId: owner, ownerName: "Prakrit Ramachandran", address: OWNER_ADDRESS }),
    ]);
    // Acting inside the owner's workspace, the owner's address is the one in use.
    await expect(resolveWorkspaceWorkEmail(db as never, co, "ws-owner")).resolves.toMatchObject({ address: OWNER_ADDRESS });
    // Acting in their own, there is none — and never the owner's.
    await expect(resolveWorkspaceWorkEmail(db as never, co, null)).resolves.toMatchObject({ owned: true, address: null });
  });

  it("lists a shared workspace whose owner has not set one up, with a null address, so the UI can say whose job it is", async () => {
    const db = seed([accepted(other, co, ["house-c"])]);
    const { emails } = await resolveWorkspaceWorkEmails(db as never, co);
    // No full name on file: the email stands in, exactly as the number does.
    expect(emails.find((e) => e.workspaceId === "ws-other")).toEqual(
      expect.objectContaining({ owned: false, ownerUserId: other, ownerName: "maya@example.com", address: null }),
    );
  });

  it("a manager with no accepted link owns their own (empty) workspace", async () => {
    const db = seed([{ ...accepted(owner, solo, ["house-a"]), status: "pending" }]);
    await expect(resolveWorkspaceWorkEmails(db as never, solo)).resolves.toEqual({
      role: "primary",
      emails: [expect.objectContaining({ owned: true, ownerUserId: solo, ownerName: "Solo", address: null })],
    });
  });
});

describe("resolveWorkspaceOwnerForWorkEmail — whose workspace an address answers for", () => {
  it("a legacy co-manager address collapses to the owner whose houses they hold", async () => {
    const db = seed([accepted(owner, co, ["house-a", "house-b"])]);
    await expect(resolveWorkspaceOwnerForWorkEmail(db as never, co)).resolves.toEqual({
      ownerUserId: owner,
      sharedFromCoManager: true,
      workspaceId: null,
    });
  });

  it("an owner's own address answers for themselves", async () => {
    await expect(resolveWorkspaceOwnerForWorkEmail(seed([]) as never, owner)).resolves.toEqual({
      ownerUserId: owner,
      sharedFromCoManager: false,
      workspaceId: null,
    });
  });
});

describe("ensureManagerAssistantEmail — a co-manager is never minted an address in the OWNER's workspace", () => {
  it("refuses a workspace-less call from a pure co-manager at the write, not only in the route", async () => {
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
  it("resolveActiveManagerWorkEmail names the workspace's address when asked for that workspace", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    const db = seed([accepted(owner, co, ["house-a"])]);
    await expect(resolveActiveManagerWorkEmail(db as never, co, "ws-owner")).resolves.toBe(OWNER_ADDRESS);
    await expect(resolveActiveManagerWorkEmail(db as never, owner)).resolves.toBe(OWNER_ADDRESS);
  });

  it("a legacy co-manager row never leaks its own address into the owner's workspace", async () => {
    vi.stubEnv("RESEND_API_KEY", "test-key");
    const db = seed([accepted(owner, co, ["house-a"])], {
      manager_assistant_emails: [
        { manager_user_id: owner, inbox_token: "tok000000001", mailbox_local: "assist-prakrit-ramachandran", provision_state: "active" },
        { manager_user_id: co, inbox_token: "tok000000002", mailbox_local: "assist-akhil", provision_state: "active" },
      ],
    });
    await expect(resolveActiveManagerWorkEmail(db as never, co, "ws-owner")).resolves.toBe(OWNER_ADDRESS);
  });

  it("an owner's outbound mail carries their own name at their own address", async () => {
    await expect(resolveManagerOutboundFrom(seed([]) as never, owner)).resolves.toBe(
      `Prakrit Ramachandran <${OWNER_ADDRESS}>`,
    );
  });

  it("falls back to the shared sender when the active workspace has no address yet", async () => {
    const db = seed([accepted(other, co, ["house-c"])]);
    await expect(resolveManagerOutboundFrom(db as never, co)).resolves.toBeNull();
  });
});

describe("the inbound path collapses before it classifies", () => {
  it("resolves the workspace owner before claiming the message or reading the sender", () => {
    const source = readFileSync("src/lib/manager-assistant-email/process-assistant-inbound.server.ts", "utf8");
    const collapse = source.indexOf("resolveWorkspaceOwnerForWorkEmail(db, mailboxUserId, {");
    const claim = source.indexOf("claimInboundEmail(db, parsed.emailId, managerUserId)");
    const classify = source.indexOf("classifyAssistantEmailSender(db, {");
    expect(collapse).toBeGreaterThan(-1);
    expect(collapse).toBeLessThan(claim);
    expect(claim).toBeLessThan(classify);
  });
});
