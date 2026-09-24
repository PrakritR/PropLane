/**
 * A manager can rename their workspace's work-email local part (Settings →
 * Messaging → Work email → Save), not just live with the auto-generated
 * `assist-<slug>` address. This pins:
 *
 * - the standalone validation rules (`isValidMailboxLocal`,
 *   `isReservedMailboxLocal`) in `assistant-email-address.ts`;
 * - `checkWorkspaceAssistantMailboxLocal` / `setWorkspaceAssistantMailboxLocal`
 *   in `manager-assistant-email.server.ts` against a small stubbed database;
 * - that inbound resolution (`resolveAssistantMailboxByInboundAddresses`)
 *   actually routes a custom local part like `frontdesk@…` to the workspace
 *   that holds it, exactly like the legacy `assistant+<token>@…` form, and
 *   that a reserved word like `support@`/`admin@` never matches any row.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";
import {
  isReservedMailboxLocal,
  isValidMailboxLocal,
} from "@/lib/manager-assistant-email/assistant-email-address";
import {
  checkWorkspaceAssistantMailboxLocal,
  resolveAssistantMailboxByInboundAddresses,
  setWorkspaceAssistantMailboxLocal,
  WorkspaceNotOwnedError,
} from "@/lib/manager-assistant-email/manager-assistant-email.server";

afterEach(() => vi.unstubAllEnvs());

describe("isValidMailboxLocal", () => {
  it("accepts lowercase letters, digits, dots and hyphens, 3-32 chars, alphanumeric ends", () => {
    expect(isValidMailboxLocal("frontdesk")).toBe(true);
    expect(isValidMailboxLocal("front.desk-2")).toBe(true);
    expect(isValidMailboxLocal("ABC")).toBe(true); // case-folded before testing
  });

  it("rejects too short, too long, bad edges, and disallowed characters", () => {
    expect(isValidMailboxLocal("ab")).toBe(false); // < 3 chars
    expect(isValidMailboxLocal("a".repeat(33))).toBe(false); // > 32 chars
    expect(isValidMailboxLocal("-frontdesk")).toBe(false); // starts non-alphanumeric
    expect(isValidMailboxLocal("frontdesk-")).toBe(false); // ends non-alphanumeric
    expect(isValidMailboxLocal("front desk")).toBe(false); // space
    expect(isValidMailboxLocal("front_desk")).toBe(false); // underscore
  });

  it("rejects any local containing '+' — the legacy assistant+<token> form stays untouched", () => {
    expect(isValidMailboxLocal("assistant+abc12345")).toBe(false);
  });
});

describe("isReservedMailboxLocal", () => {
  it.each(["support", "admin", "postmaster", "assist", "assistant", "noreply", "proplane"])(
    "reserves %s",
    (word) => {
      expect(isReservedMailboxLocal(word)).toBe(true);
      expect(isReservedMailboxLocal(word.toUpperCase())).toBe(true);
    },
  );

  it("does not reserve an ordinary custom local", () => {
    expect(isReservedMailboxLocal("frontdesk")).toBe(false);
  });
});

const owner = "owner-1";
const otherOwner = "other-owner";
const coManager = "co-1";

function seedDb() {
  return createMemoryDb({
    profiles: [
      { id: owner, full_name: "Owner Name", email: "owner@example.com" },
      { id: otherOwner, full_name: "Other Owner", email: "other@example.com" },
    ],
    manager_assistant_emails: [
      {
        manager_user_id: owner,
        workspace_id: "ws-owner",
        inbox_token: "tok000000001",
        mailbox_local: "assist-owner-name",
        provision_state: "active",
      },
      {
        manager_user_id: otherOwner,
        workspace_id: "ws-other",
        inbox_token: "tok000000002",
        mailbox_local: "frontdesk",
        provision_state: "active",
      },
    ],
  });
}

const OWNER_WORKSPACE = { id: "ws-owner", ownerUserId: owner, owned: true, isDefault: true };
const SHARED_WORKSPACE = { id: "ws-owner", ownerUserId: owner, owned: false, isDefault: true };

describe("checkWorkspaceAssistantMailboxLocal", () => {
  it("is available when nobody holds it", async () => {
    await expect(
      checkWorkspaceAssistantMailboxLocal(seedDb() as never, "ws-owner", "brandnew"),
    ).resolves.toEqual({ ok: true, state: "available" });
  });

  it("is current when it is already this workspace's own local part", async () => {
    await expect(
      checkWorkspaceAssistantMailboxLocal(seedDb() as never, "ws-owner", "assist-owner-name"),
    ).resolves.toEqual({ ok: true, state: "current" });
  });

  it("is taken when another workspace's active row holds it", async () => {
    await expect(
      checkWorkspaceAssistantMailboxLocal(seedDb() as never, "ws-owner", "frontdesk"),
    ).resolves.toEqual({
      ok: false,
      state: "taken",
      message: "That address is already in use.",
    });
  });

  it("is reserved for an official-sounding local", async () => {
    await expect(
      checkWorkspaceAssistantMailboxLocal(seedDb() as never, "ws-owner", "support"),
    ).resolves.toEqual({ ok: false, state: "reserved", message: "That address is reserved." });
  });

  it("is invalid — too short — before it is ever checked against reserved words or the database", async () => {
    await expect(
      checkWorkspaceAssistantMailboxLocal(seedDb() as never, "ws-owner", "ab"),
    ).resolves.toEqual({ ok: false, state: "invalid", message: "At least 3 characters" });
  });

  it("is invalid — bad characters — with the character-class message", async () => {
    await expect(
      checkWorkspaceAssistantMailboxLocal(seedDb() as never, "ws-owner", "front_desk"),
    ).resolves.toEqual({
      ok: false,
      state: "invalid",
      message: "Letters, digits, dots and hyphens only",
    });
  });
});

describe("setWorkspaceAssistantMailboxLocal", () => {
  it("renames the workspace's active row and returns the new address", async () => {
    const db = seedDb();
    await expect(
      setWorkspaceAssistantMailboxLocal(db as never, owner, OWNER_WORKSPACE, "newname"),
    ).resolves.toEqual({ ok: true, address: "newname@proplane.ai" });

    const { data } = await (db as unknown as {
      from: (t: string) => { select: () => Promise<{ data: { workspace_id: string; mailbox_local: string }[] }> };
    })
      .from("manager_assistant_emails")
      .select();
    const row = (data as { workspace_id: string; mailbox_local: string }[]).find(
      (r) => r.workspace_id === "ws-owner",
    );
    expect(row?.mailbox_local).toBe("newname");
  });

  it("is a no-op that still returns the address when the requested local is already current", async () => {
    const db = seedDb();
    await expect(
      setWorkspaceAssistantMailboxLocal(db as never, owner, OWNER_WORKSPACE, "assist-owner-name"),
    ).resolves.toEqual({ ok: true, address: "assist-owner-name@proplane.ai" });
  });

  it("refuses a local already active on another workspace, without mutating either row", async () => {
    const db = seedDb();
    await expect(
      setWorkspaceAssistantMailboxLocal(db as never, owner, OWNER_WORKSPACE, "frontdesk"),
    ).resolves.toEqual({
      ok: false,
      state: "taken",
      message: "That address is already in use.",
    });

    const { data } = await (db as unknown as {
      from: (t: string) => { select: () => Promise<{ data: { workspace_id: string; mailbox_local: string }[] }> };
    })
      .from("manager_assistant_emails")
      .select();
    const rows = data as { workspace_id: string; mailbox_local: string }[];
    expect(rows.find((r) => r.workspace_id === "ws-owner")?.mailbox_local).toBe(
      "assist-owner-name",
    );
    expect(rows.find((r) => r.workspace_id === "ws-other")?.mailbox_local).toBe("frontdesk");
  });

  it("refuses a reserved local", async () => {
    await expect(
      setWorkspaceAssistantMailboxLocal(seedDb() as never, owner, OWNER_WORKSPACE, "admin"),
    ).resolves.toEqual({ ok: false, state: "reserved", message: "That address is reserved." });
  });

  it("refuses a co-manager acting in a workspace they do not own, same guard ensureManagerAssistantEmail uses", async () => {
    await expect(
      setWorkspaceAssistantMailboxLocal(seedDb() as never, coManager, SHARED_WORKSPACE, "frontdesk2"),
    ).rejects.toBeInstanceOf(WorkspaceNotOwnedError);
  });
});

describe("inbound resolution routes a custom local part like the legacy token form", () => {
  it("routes frontdesk@<domain> to the workspace holding mailbox_local = \"frontdesk\"", async () => {
    vi.stubEnv("ASSISTANT_EMAIL_DOMAIN", "proplane.ai");
    await expect(
      resolveAssistantMailboxByInboundAddresses(seedDb() as never, ["frontdesk@proplane.ai"]),
    ).resolves.toEqual({ managerUserId: otherOwner, workspaceId: "ws-other" });
  });

  it("still routes the legacy assistant+<token>@ form", async () => {
    vi.stubEnv("ASSISTANT_EMAIL_DOMAIN", "proplane.ai");
    await expect(
      resolveAssistantMailboxByInboundAddresses(seedDb() as never, [
        "assistant+tok000000001@proplane.ai",
      ]),
    ).resolves.toEqual({ managerUserId: owner, workspaceId: "ws-owner" });
  });

  it.each(["support@proplane.ai", "admin@proplane.ai"])(
    "never matches a reserved local (%s), even with no row to find",
    async (address) => {
      vi.stubEnv("ASSISTANT_EMAIL_DOMAIN", "proplane.ai");
      await expect(
        resolveAssistantMailboxByInboundAddresses(seedDb() as never, [address]),
      ).resolves.toBeNull();
    },
  );
});
