/**
 * Security-review finding (promote gate, Sep 2026): renaming a workspace's
 * work email freed the old local part immediately — the uniqueness index
 * (`manager_assistant_emails_mailbox_local_uniq`) only constrains ACTIVE
 * rows, and a rename overwrites the same row's `mailbox_local` in place
 * rather than leaving anything behind, so any other workspace could claim
 * the old local part and start receiving mail senders still addressed to the
 * previous owner.
 *
 * This pins the fix: a rename now holds the old local part as an alias in
 * `manager_assistant_email_aliases` for `RELEASED_MAILBOX_ALIAS_DAYS` (30
 * days) — unclaimable by anyone else during that window, still routed to the
 * SAME row inbound, and cleared automatically if its own former owner
 * reclaims it, or once it expires.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";
import {
  RELEASED_MAILBOX_ALIAS_DAYS,
  findActiveMailboxLocalAlias,
} from "@/lib/manager-assistant-email/assistant-mailbox-local.server";
import {
  checkWorkspaceAssistantMailboxLocal,
  resolveAssistantMailboxByInboundAddresses,
  setWorkspaceAssistantMailboxLocal,
} from "@/lib/manager-assistant-email/manager-assistant-email.server";

afterEach(() => vi.unstubAllEnvs());

const owner = "owner-1";
const otherOwner = "other-owner";

function seedDb() {
  return createMemoryDb({
    profiles: [
      { id: owner, full_name: "Owner Name", email: "owner@example.com" },
      { id: otherOwner, full_name: "Other Owner", email: "other@example.com" },
    ],
    manager_assistant_emails: [
      {
        id: "row-owner",
        manager_user_id: owner,
        workspace_id: "ws-owner",
        inbox_token: "tok000000001",
        mailbox_local: "assist-owner-name",
        provision_state: "active",
      },
      {
        id: "row-other",
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
const OTHER_WORKSPACE = { id: "ws-other", ownerUserId: otherOwner, owned: true, isDefault: true };

function aliasRows(db: ReturnType<typeof seedDb>) {
  return (db.__tables.manager_assistant_email_aliases ?? []) as Array<{
    mailbox_local: string;
    assistant_email_id: string;
    owner_user_id: string;
    released_at: string;
    expires_at: string;
  }>;
}

describe("renaming a work email holds the old local as a 30-day alias", () => {
  it("records an alias with a 30-day expiry", async () => {
    vi.stubEnv("ASSISTANT_EMAIL_DOMAIN", "prop-lane.space");
    const db = seedDb();
    await expect(
      setWorkspaceAssistantMailboxLocal(db as never, owner, OWNER_WORKSPACE, "newname"),
    ).resolves.toEqual({ ok: true, address: "newname@prop-lane.space" });

    const rows = aliasRows(db);
    expect(rows).toHaveLength(1);
    const [alias] = rows;
    expect(alias.mailbox_local).toBe("assist-owner-name");
    expect(alias.assistant_email_id).toBe("row-owner");
    expect(alias.owner_user_id).toBe(owner);

    const releasedMs = new Date(alias.released_at).getTime();
    const expiresMs = new Date(alias.expires_at).getTime();
    const expectedMs = RELEASED_MAILBOX_ALIAS_DAYS * 24 * 60 * 60 * 1000;
    expect(expiresMs - releasedMs).toBe(expectedMs);
  });

  it("another workspace cannot claim it during the cooldown — same refusal shape as an active collision", async () => {
    vi.stubEnv("ASSISTANT_EMAIL_DOMAIN", "prop-lane.space");
    const db = seedDb();
    await setWorkspaceAssistantMailboxLocal(db as never, owner, OWNER_WORKSPACE, "newname");

    await expect(
      checkWorkspaceAssistantMailboxLocal(db as never, "ws-other", "assist-owner-name", otherOwner),
    ).resolves.toEqual({
      ok: false,
      state: "taken",
      message: "That address is already in use.",
    });

    await expect(
      setWorkspaceAssistantMailboxLocal(db as never, otherOwner, OTHER_WORKSPACE, "assist-owner-name"),
    ).resolves.toEqual({
      ok: false,
      state: "taken",
      message: "That address is already in use.",
    });
    // The other workspace's own row is untouched by the refused attempt.
    const rows = db.__tables.manager_assistant_emails as Array<{ workspace_id: string; mailbox_local: string }>;
    expect(rows.find((r) => r.workspace_id === "ws-other")?.mailbox_local).toBe("frontdesk");
  });

  it("the same former owner can reclaim it, and the alias row is removed", async () => {
    vi.stubEnv("ASSISTANT_EMAIL_DOMAIN", "prop-lane.space");
    const db = seedDb();
    await setWorkspaceAssistantMailboxLocal(db as never, owner, OWNER_WORKSPACE, "newname");
    expect(aliasRows(db)).toHaveLength(1);

    await expect(
      checkWorkspaceAssistantMailboxLocal(db as never, "ws-owner", "assist-owner-name", owner),
    ).resolves.toEqual({ ok: true, state: "available" });

    await expect(
      setWorkspaceAssistantMailboxLocal(db as never, owner, OWNER_WORKSPACE, "assist-owner-name"),
    ).resolves.toEqual({ ok: true, address: "assist-owner-name@prop-lane.space" });

    // The reclaimed local's own alias is gone — nothing blocks it any more —
    // even though renaming away from "newname" released a fresh alias for
    // THAT local in its place.
    const rows = aliasRows(db);
    expect(rows.find((r) => r.mailbox_local === "assist-owner-name")).toBeUndefined();
    expect(rows.find((r) => r.mailbox_local === "newname")?.owner_user_id).toBe(owner);
  });

  it("inbound mail to the aliased local still resolves to the same workspace", async () => {
    vi.stubEnv("ASSISTANT_EMAIL_DOMAIN", "prop-lane.space");
    const db = seedDb();
    await setWorkspaceAssistantMailboxLocal(db as never, owner, OWNER_WORKSPACE, "newname");

    await expect(
      resolveAssistantMailboxByInboundAddresses(db as never, ["assist-owner-name@prop-lane.space"]),
    ).resolves.toEqual({ managerUserId: owner, workspaceId: "ws-owner" });
    // The renamed address keeps working too — same row either way.
    await expect(
      resolveAssistantMailboxByInboundAddresses(db as never, ["newname@prop-lane.space"]),
    ).resolves.toEqual({ managerUserId: owner, workspaceId: "ws-owner" });
  });

  it("an expired alias is not claimable-blocking and does not route inbound mail", async () => {
    vi.stubEnv("ASSISTANT_EMAIL_DOMAIN", "prop-lane.space");
    const db = seedDb();
    await setWorkspaceAssistantMailboxLocal(db as never, owner, OWNER_WORKSPACE, "newname");
    const [alias] = aliasRows(db);
    // Back-date the alias past its cooldown, as if 30+ days had elapsed.
    alias.expires_at = new Date(Date.now() - 1000).toISOString();

    await expect(findActiveMailboxLocalAlias(db as never, "assist-owner-name")).resolves.toBeNull();

    await expect(
      checkWorkspaceAssistantMailboxLocal(db as never, "ws-other", "assist-owner-name", otherOwner),
    ).resolves.toEqual({ ok: true, state: "available" });

    await expect(
      resolveAssistantMailboxByInboundAddresses(db as never, ["assist-owner-name@prop-lane.space"]),
    ).resolves.toBeNull();
  });
});

describe("an alias belongs to the workspace of the mailbox row it routes to", () => {
  it("a workspace under the SAME owner user cannot claim it; the holding workspace can", async () => {
    vi.stubEnv("ASSISTANT_EMAIL_DOMAIN", "prop-lane.space");
    const db = seedDb();
    (db.__tables.manager_assistant_emails as Array<Record<string, unknown>>).push({
      id: "row-sibling",
      manager_user_id: owner,
      workspace_id: "ws-sibling",
      inbox_token: "tok000000003",
      mailbox_local: "siblinghomes",
      provision_state: "active",
    });
    await setWorkspaceAssistantMailboxLocal(db as never, owner, OWNER_WORKSPACE, "newname");

    await expect(
      checkWorkspaceAssistantMailboxLocal(db as never, "ws-sibling", "assist-owner-name", owner),
    ).resolves.toMatchObject({ ok: false, state: "taken" });
    await expect(
      checkWorkspaceAssistantMailboxLocal(db as never, "ws-owner", "assist-owner-name", owner),
    ).resolves.toEqual({ ok: true, state: "available" });
  });

  it("a legacy alias (mailbox row has no workspace) is the owner's sole workspace's, otherwise taken", async () => {
    const db = seedDb();
    (db.__tables.manager_assistant_emails as Array<Record<string, unknown>>).push({
      id: "row-legacy",
      manager_user_id: owner,
      workspace_id: null,
      inbox_token: "tok000000004",
      mailbox_local: "legacynow",
      provision_state: "active",
    });
    db.__tables.manager_assistant_email_aliases = [
      {
        mailbox_local: "legacyold",
        assistant_email_id: "row-legacy",
        owner_user_id: owner,
        released_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 86_400_000).toISOString(),
      },
    ];
    db.__tables.portal_workspaces = [{ id: "ws-owner", owner_user_id: owner }];
    await expect(checkWorkspaceAssistantMailboxLocal(db as never, "ws-owner", "legacyold", owner)).resolves.toEqual({
      ok: true,
      state: "available",
    });
    // Another owner never reclaims it.
    await expect(checkWorkspaceAssistantMailboxLocal(db as never, "ws-other", "legacyold", otherOwner)).resolves.toMatchObject({
      ok: false,
      state: "taken",
    });
    // The owner now has a second workspace: the legacy alias is no longer unambiguously either one's.
    (db.__tables.portal_workspaces as Array<Record<string, unknown>>).push({ id: "ws-second", owner_user_id: owner });
    await expect(checkWorkspaceAssistantMailboxLocal(db as never, "ws-owner", "legacyold", owner)).resolves.toMatchObject({
      ok: false,
      state: "taken",
    });
  });
});

describe("the claim check fails closed when the alias read fails", () => {
  function aliasReadFails(db: ReturnType<typeof seedDb>) {
    return {
      from(table: string) {
        if (table !== "manager_assistant_email_aliases") return db.from(table);
        const builder: Record<string, unknown> = {};
        for (const m of ["select", "eq", "upsert", "delete"]) builder[m] = () => builder;
        builder.maybeSingle = async () => ({ data: null, error: { message: "boom" } });
        return builder;
      },
    };
  }

  it("findActiveMailboxLocalAlias throws instead of reporting no alias", async () => {
    await expect(findActiveMailboxLocalAlias(aliasReadFails(seedDb()) as never, "anything")).rejects.toThrow("boom");
  });

  it("check is unavailable (throws) and set refuses; nothing is written", async () => {
    vi.stubEnv("ASSISTANT_EMAIL_DOMAIN", "prop-lane.space");
    const db = seedDb();
    const failing = aliasReadFails(db);
    await expect(checkWorkspaceAssistantMailboxLocal(failing as never, "ws-other", "somelocal", otherOwner)).rejects.toThrow();
    await expect(setWorkspaceAssistantMailboxLocal(failing as never, otherOwner, OTHER_WORKSPACE, "somelocal")).rejects.toThrow();
    const rows = db.__tables.manager_assistant_emails as Array<{ workspace_id: string; mailbox_local: string }>;
    expect(rows.find((r) => r.workspace_id === "ws-other")?.mailbox_local).toBe("frontdesk");
  });

  it("inbound routing still degrades to not-found rather than throwing", async () => {
    await expect(
      resolveAssistantMailboxByInboundAddresses(aliasReadFails(seedDb()) as never, ["nobody@prop-lane.space"]),
    ).resolves.toBeNull();
  });
});
