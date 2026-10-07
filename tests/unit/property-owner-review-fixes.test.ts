/**
 * The review round on the Property owner role, as tests.
 *
 *  - Messages is two-way: the manager may answer the thread the owner opened,
 *    and the owner's own reader shows that answer;
 *  - Statements' house filter comes from the Statements grant, not from the
 *    performance-scoped summary;
 *  - months default to the PACIFIC calendar month, like every other money view;
 *  - an unreadable owner membership denies (503), it never hands over a shell;
 *  - a superseded document version stops minting bytes;
 *  - accepting an owner invite does not rewrite `profiles.role`;
 *  - a delegate cannot hand out owner keys they do not hold themselves.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/portal-inbox-delivery", () => ({
  deliverPortalInboxMessage: vi.fn(async () => ({ ok: true, recipientCount: 1, emailOutcomes: [], smsOutcomes: [] })),
}));

import {
  managerMayMessageOwner,
  ownerInviteeIdsForManagers,
  ownerAccessStateFor,
  OwnerAccessUnavailableError,
  type OwnerGrant,
} from "@/lib/property-owner/access.server";
import { mintOwnerDocumentUrl } from "@/lib/property-owner/documents.server";
import { loadOwnerConversations } from "@/lib/property-owner/messages.server";
import { provisionOwnerOnlyAccess } from "@/lib/property-owner/provision.server";
import { refuseOwnerOnly } from "@/lib/property-owner/route-auth.server";
import { loadOwnerSummary, loadOwnerStatements } from "@/lib/property-owner/summary.server";
import { pacificCalendarMonthKey } from "@/lib/pacific-time";
import { ownerPermissionsExceedGrant } from "@/lib/co-manager-permissions";
import { makeFakeDb, type FakeDbWrite } from "./property-owner-fake-db";

const MANAGER = "manager-1";
const OTHER_MANAGER = "manager-2";
const OWNER = "owner-1";
const HOUSE = "house-a";

const read = (p: string) => readFileSync(p, "utf8");

function ownerLinkRow(over: Record<string, unknown> = {}) {
  return {
    id: "link-1",
    inviter_user_id: MANAGER,
    invitee_user_id: OWNER,
    status: "accepted",
    team_role: "property_owner",
    workspace_id: "ws-1",
    house_scope: "selected",
    assigned_property_ids: [HOUSE],
    property_co_manager_permissions: {
      [HOUSE]: { ownerPerformance: { read: true }, ownerStatements: { read: true }, ownerMessages: { read: true } },
    },
    co_manager_permissions: {},
    ...over,
  };
}

const grants = (messages: boolean, manager = MANAGER): OwnerGrant[] => [
  { linkId: "link-1", managerUserId: manager, houses: [{ propertyId: HOUSE, performance: true, statements: true, documents: true, messages }] },
];

describe("owner Messages is two-way", () => {
  it("names the owner as a candidate for the manager who invited them, and nobody else", async () => {
    const db = makeFakeDb({ account_link_invites: [ownerLinkRow()] });
    expect([...(await ownerInviteeIdsForManagers(db, [MANAGER]))]).toEqual([OWNER]);
    expect([...(await ownerInviteeIdsForManagers(db, [OTHER_MANAGER]))]).toEqual([]);
    expect([...(await ownerInviteeIdsForManagers(db, []))]).toEqual([]);
  });

  it("lets the manager answer only while Messages is on for a house of theirs", async () => {
    const tables = {
      account_link_invites: [ownerLinkRow()],
      profiles: [
        { id: OWNER, email: "dana@example.com" },
        { id: MANAGER, email: "manager@example.com" },
      ],
      manager_property_records: [{ id: HOUSE, manager_user_id: MANAGER, workspace_id: "ws-1" }],
    };
    expect(await managerMayMessageOwner(makeFakeDb(tables), MANAGER, OWNER)).toBe(true);
    // Another manager may never reach this owner, and neither may their own
    // manager once Messages is turned off.
    expect(await managerMayMessageOwner(makeFakeDb(tables), OTHER_MANAGER, OWNER)).toBe(false);
    const off = {
      ...tables,
      account_link_invites: [
        ownerLinkRow({
          property_co_manager_permissions: { [HOUSE]: { ownerPerformance: { read: true }, ownerMessages: { notification: false } } },
        }),
      ],
    };
    expect(await managerMayMessageOwner(makeFakeDb(off), MANAGER, OWNER)).toBe(false);
  });

  it("the manager's recipient scope consults the membership, not the teammate sources", () => {
    const src = read("src/lib/inbox-recipient-scope.ts");
    expect(src).toContain("ownerInviteeIdsForManagers(db, [sender.id])");
    expect(src).toMatch(/ownerInviteeIds\.has\(recipient\.userId\) &&\s*\(await managerMayMessageOwner\(db, sender\.id, recipient\.userId\)\)/);
  });

  it("the owner's reader shows the manager's reply (a received row names the owner as participant)", async () => {
    const db = makeFakeDb({
      profiles: [
        { id: OWNER, email: "dana@example.com", full_name: "Dana" },
        { id: MANAGER, email: "manager@example.com", full_name: "Mgr" },
      ],
      portal_inbox_thread_records: [
        {
          scope: "axis_portal_inbox_manager_v1",
          owner_user_id: OWNER,
          participant_email: null,
          created_at: "2026-10-01T10:00:00Z",
          row_data: { id: "s1", body: "Is the roof done?", email: "manager@example.com", folder: "sent" },
        },
        {
          // How delivery writes the owner's copy of the manager's reply: the
          // participant column is the OWNER's own address.
          scope: "axis_portal_inbox_manager_v1",
          owner_user_id: OWNER,
          participant_email: "dana@example.com",
          created_at: "2026-10-01T11:00:00Z",
          row_data: { id: "i1", body: "Finished Tuesday", email: "manager@example.com", folder: "inbox" },
        },
        {
          scope: "axis_portal_inbox_manager_v1",
          owner_user_id: OWNER,
          participant_email: "dana@example.com",
          created_at: "2026-10-01T12:00:00Z",
          row_data: { id: "r1", body: "resident secret", email: "resident@example.com", folder: "inbox" },
        },
      ],
    });
    const conversations = await loadOwnerConversations(db, OWNER, grants(true));
    expect(conversations[0]!.messages).toEqual([
      { id: "s1", body: "Is the roof done?", at: "2026-10-01T10:00:00Z", fromMe: true },
      { id: "i1", body: "Finished Tuesday", at: "2026-10-01T11:00:00Z", fromMe: false },
    ]);
    expect(JSON.stringify(conversations)).not.toContain("resident secret");
  });

  it("reads the owner's inbox rows once, however many memberships they have", async () => {
    const reads: Record<string, number> = {};
    const db = makeFakeDb(
      {
        profiles: [
          { id: OWNER, email: "dana@example.com" },
          { id: MANAGER, email: "manager@example.com" },
          { id: OTHER_MANAGER, email: "two@example.com" },
        ],
        portal_inbox_thread_records: [],
      },
      { reads },
    );
    await loadOwnerConversations(db, OWNER, [...grants(true), ...grants(true, OTHER_MANAGER)]);
    expect(reads.portal_inbox_thread_records).toBe(1);
  });

  it("the owner send is rate limited per account and per IP", () => {
    const src = read("src/app/api/owner/messages/route.ts");
    expect(src).toContain("owner-message:user:");
    expect(src).toContain("owner-message:ip:");
    expect(src).toContain("status: 429");
  });
});

describe("owner months are Pacific months", () => {
  const untouchable = new Proxy({}, { get: () => { throw new Error("db touched"); } }) as never;

  it("the summary with no period asked for is the Pacific calendar month", async () => {
    const summary = await loadOwnerSummary(untouchable, [], { period: null });
    expect(summary.period).toBe(pacificCalendarMonthKey(Date.now()));
    expect(summary.chart.at(-1)!.month).toBe(summary.period);
  });

  it("neither owner reader derives a month from UTC", () => {
    const src = read("src/lib/property-owner/summary.server.ts");
    expect(src).not.toContain('new Date().toISOString().slice(0, 7)');
    expect(src.match(/pacificCalendarMonthKey\(Date\.now\(\)\)/g)?.length).toBe(2);
  });
});

describe("the Statements house filter follows the Statements grant", () => {
  it("returns the houses statements are granted for, and nothing the request named", async () => {
    const db = makeFakeDb({ ledger_entries: [], manager_expense_entries: [], manager_bills: [], manager_property_records: [] });
    const statementsOnly: OwnerGrant[] = [
      {
        linkId: "link-1",
        managerUserId: MANAGER,
        houses: [
          { propertyId: HOUSE, performance: false, statements: true, documents: false, messages: false },
          { propertyId: "house-b", performance: true, statements: false, documents: false, messages: false },
        ],
      },
    ];
    const out = await loadOwnerStatements(db, statementsOnly, { months: 2 });
    expect(out.houses.map((h) => h.propertyId)).toEqual([HOUSE]);
    expect(out.rows).toHaveLength(2);
    // An owner with no statements house at all gets an empty tab list.
    const none = await loadOwnerStatements(db, [{ linkId: "l", managerUserId: MANAGER, houses: [] }], {});
    expect(none).toEqual({ rows: [], houses: [] });
  });

  it("the page builds its tabs from the statements response, never from /api/owner/summary", () => {
    const src = read("src/components/owner/owner-statements.tsx");
    expect(src).not.toContain("/api/owner/summary");
    expect(src).toContain("all.data?.houses ?? []");
  });
});

describe("an unreadable owner membership denies", () => {
  it("the state read fails closed instead of answering 'no owner row'", async () => {
    const db = makeFakeDb({ account_link_invites: [] }, { errors: { account_link_invites: { message: "boom" } } });
    await expect(ownerAccessStateFor(db, OWNER)).rejects.toBeInstanceOf(OwnerAccessUnavailableError);
    const refusal = await refuseOwnerOnly(db, OWNER);
    expect(refusal?.status).toBe(503);
  });

  it("an owner-only account still gets 403, and a manager still passes", async () => {
    const ownerDb = makeFakeDb({
      account_link_invites: [ownerLinkRow()],
      manager_property_records: [{ id: HOUSE, manager_user_id: MANAGER, workspace_id: "ws-1" }],
      manager_purchases: [],
      profile_roles: [{ user_id: OWNER, role: "manager" }],
      profiles: [{ id: OWNER, email: "dana@example.com" }],
    });
    expect((await refuseOwnerOnly(ownerDb, OWNER))?.status).toBe(403);
    const managerDb = makeFakeDb({ account_link_invites: [] });
    expect(await refuseOwnerOnly(managerDb, MANAGER)).toBeNull();
  });

  it("the portal layout redirects when it cannot see the path", () => {
    const src = read("src/app/portal/layout.tsx");
    expect(src).toContain('ownerRedirectFor(pathname, owner.messagesOn) : OWNER_HOME_PATH');
  });
});

describe("owner documents and the statement PDF", () => {
  function dbWithStorage(rows: Record<string, unknown>[]) {
    const db = makeFakeDb({ manager_documents: rows }) as unknown as Record<string, unknown>;
    db.storage = { from: () => ({ createSignedUrl: async (path: string) => ({ data: { signedUrl: `https://signed.test/${path}` }, error: null }) }) };
    return db as never;
  }
  const DOC = "11111111-1111-4111-8111-111111111111";
  const doc = (over: Record<string, unknown>) => ({
    id: DOC,
    manager_user_id: MANAGER,
    property_id: HOUSE,
    display_name: "Roof invoice",
    original_filename: null,
    mime_type: "application/pdf",
    size_bytes: 10,
    created_at: "2026-10-01T00:00:00Z",
    storage_path: `manager/${MANAGER}/${DOC}.pdf`,
    shared_with_owners: true,
    deleted_at: null,
    superseded_by_document_id: null,
    ...over,
  });

  it("a superseded version mints nothing, exactly like a deleted one", async () => {
    expect(await mintOwnerDocumentUrl(dbWithStorage([doc({})]), grants(false), DOC, false)).not.toBeNull();
    expect(
      await mintOwnerDocumentUrl(dbWithStorage([doc({ superseded_by_document_id: "22222222-2222-4222-8222-222222222222" })]), grants(false), DOC, false),
    ).toBeNull();
  });

  it("the owner's statement PDF carries no manager street address", () => {
    const src = read("src/app/api/owner/statements/pdf/route.ts");
    expect(src).not.toContain("address_line1");
    expect(src).toContain('.select("legal_name")');
  });

  it("the owner document row renders its date in Pacific time", () => {
    const src = read("src/components/owner/owner-documents.tsx");
    expect(src).toContain("formatPacificDate(doc.createdAt");
    expect(src).not.toContain("toLocaleDateString");
  });
});

describe("accepting an owner invite", () => {
  it("keeps the role the account was created as", async () => {
    const writes: FakeDbWrite[] = [];
    const resident = makeFakeDb({ profiles: [{ id: OWNER, role: "resident", full_name: "Dana", application_approved: true }] }, { writes });
    await provisionOwnerOnlyAccess(resident, { id: OWNER, email: "dana@example.com", fullName: "Dana" });
    expect(writes.find((w) => w.table === "profiles")?.values.role).toBe("resident");

    writes.length = 0;
    const brandNew = makeFakeDb({ profiles: [] }, { writes });
    await provisionOwnerOnlyAccess(brandNew, { id: "owner-2", email: "new@example.com", fullName: null });
    expect(writes.find((w) => w.table === "profiles")?.values.role).toBe("manager");
    // The portal role row is the grant, and it is still added either way.
    expect(writes.some((w) => w.table === "profile_roles")).toBe(true);
  });
});

describe("a delegate cannot hand out owner keys they do not hold", () => {
  it("each owner key is capped by the module it reads from", () => {
    const owner = { ownerPerformance: { read: true }, ownerStatements: { read: true }, ownerDocuments: { read: true }, ownerMessages: { read: true } };
    expect(ownerPermissionsExceedGrant({ teams: { read: true, edit: true } }, owner)).toBe(true);
    expect(ownerPermissionsExceedGrant({ financials: { read: true } }, { ownerStatements: { read: true } })).toBe(false);
    expect(ownerPermissionsExceedGrant({ financials: { read: true } }, { ownerDocuments: { read: true } })).toBe(true);
    expect(ownerPermissionsExceedGrant({ documents: { read: true } }, { ownerDocuments: { read: true } })).toBe(false);
    expect(ownerPermissionsExceedGrant({ inbox: { edit: true } }, { ownerMessages: { read: true } })).toBe(false);
    // A key turned off is nothing to cap.
    expect(ownerPermissionsExceedGrant({}, { ownerStatements: { notification: false } })).toBe(false);
  });

  it("both write paths run the owner keys through that cap after re-deriving them", () => {
    for (const file of ["src/app/api/pro/account-links/route.ts", "src/lib/invite-links/invite-links.server.ts"]) {
      const src = read(file);
      expect(src.lastIndexOf("capOwnerKeysForDelegate"), file).toBeGreaterThan(src.indexOf('=== "property_owner"'));
    }
  });

  it("an owner invite does not start from 'all houses'", () => {
    const src = read("src/components/portal/workspace-invite-sheet.tsx");
    expect(src).toContain('if (role === "property_owner") return "selected"');
    // The role-change coercion lives in houseScopeForRoleChange (workspace-membership.test.ts).
    expect(src).toContain("houseScopeForRoleChange(next");
  });
});

describe("the Overview keeps real figures", () => {
  it("only an owner with no houses sees the empty state", () => {
    const src = read("src/components/owner/owner-overview.tsx");
    expect(src).not.toContain("const quiet");
    expect(src).toContain("empty || !data ?");
  });

  it("the owner send button has one path, not a form and an onClick", () => {
    const src = read("src/components/owner/owner-messages.tsx");
    expect(src).toContain('loading={busy === conversation.conversationId}');
    expect(src).not.toMatch(/onClick=\{\(\) => send\(/);
  });
});

describe("a workspace check never spends its one row on an owner", () => {
  it("managerMayUseWorkspace reads without a limit, because owner rows are dropped in JS", () => {
    const src = read("src/lib/communication/conversation-key.server.ts");
    const fn = src.slice(src.indexOf("async function managerMayUseWorkspace"));
    const body = fn.slice(0, fn.indexOf("\n}"));
    expect(body).toContain("withoutOwnerLinks");
    expect(body).not.toContain(".limit(");
  });
});
