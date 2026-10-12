/**
 * A workspace's Communication lists only its own people. The applications read is scoped on the
 * server; this is the second check at the point the contact list (and so the "No messages yet"
 * placeholder rows) is built, so one owner's residents can never appear in another's workspace —
 * the production leak was a platform admin whose manager portal received every owner's rows.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";
import { EMPTY_COMMUNICATION_THREAD_FILTERS } from "@/lib/communication-thread-filters";
import { buildResidentPlaceholderInboxItems } from "@/lib/communication-resident-placeholders";
import type { WorkspacePayload } from "@/lib/workspaces/types";

const state = vi.hoisted(() => ({ rows: [] as unknown[], invites: [] as unknown[] }));

vi.mock("@/lib/manager-applications-storage", () => ({ readManagerApplicationRows: () => state.rows }));
vi.mock("@/lib/portal-data-store", () => ({ readCachedAccountLinkInvites: () => state.invites }));
vi.mock("@/lib/pro-relationships", () => ({ readProRelationships: () => [] }));
vi.mock("@/lib/manager-vendors-storage", () => ({
  readOwnActiveManagerVendorRows: () => [],
  isVendorCategorySettingsRow: () => false,
}));

import { buildManagerInboxLiveContacts } from "@/lib/manager-inbox-contacts";
import { setWorkspaceSelection } from "@/lib/workspaces/selection";

const ADMIN = "admin-prakrit";
const AMBIKA = "owner-ambika";
const CO = "co-manager";
const MINE_WS = "ws-admin-default";
const SEATTLE_WS = "ws-ambika-default";
const SEATTLE_HOUSE = "house-seattle-homes";
const OWN_HOUSE = "house-admin-own";

function resident(id: string, owner: string, house: string, over: Partial<DemoApplicantRow> = {}): DemoApplicantRow {
  return {
    id,
    name: id,
    email: `${id.toLowerCase()}@example.test`,
    bucket: "approved",
    stage: "Active",
    detail: "",
    managerUserId: owner,
    propertyId: house,
    property: house,
    ...over,
  } as DemoApplicantRow;
}

function workspace(id: string, owner: string, owned: boolean, propertyIds: string[]) {
  return { id, name: id, ownerUserId: owner, owned, isDefault: owned, propertyIds, propertyPermissions: {} } as unknown as WorkspacePayload["workspaces"][number];
}

function select(workspaces: WorkspacePayload["workspaces"], active: string) {
  setWorkspaceSelection({ workspaces, activeWorkspaceId: active });
}

function placeholderNames(userId: string, dismissed: string[] = []) {
  const contacts = buildManagerInboxLiveContacts(userId);
  return buildResidentPlaceholderInboxItems({
    contacts,
    filters: EMPTY_COMMUNICATION_THREAD_FILTERS,
    occupiedEmails: new Set(),
    listSegment: "active",
    dismissedKeys: new Set(dismissed),
  }).map((item) => item.name);
}

beforeEach(() => {
  state.rows = [];
  state.invites = [];
  setWorkspaceSelection(null);
});

describe("Communication contacts follow the active workspace and the viewer's access", () => {
  it("an admin viewer sees none of another owner's residents, even if the read returned them", () => {
    select([workspace(MINE_WS, ADMIN, true, [])], MINE_WS);
    state.rows = [resident("Khue", AMBIKA, SEATTLE_HOUSE), resident("Shivansh", AMBIKA, SEATTLE_HOUSE)];
    expect(placeholderNames(ADMIN)).toEqual([]);
  });

  it("keeps the viewer's own resident in the workspace that holds the house", () => {
    select([workspace(MINE_WS, ADMIN, true, [OWN_HOUSE])], MINE_WS);
    state.rows = [resident("Mine", ADMIN, OWN_HOUSE), resident("Khue", AMBIKA, SEATTLE_HOUSE)];
    expect(placeholderNames(ADMIN)).toEqual(["Mine"]);
  });

  it("a house in another of the viewer's workspaces is not listed here", () => {
    select([workspace(MINE_WS, ADMIN, true, [OWN_HOUSE]), workspace("ws-second", ADMIN, true, ["house-second"])], MINE_WS);
    state.rows = [resident("Mine", ADMIN, OWN_HOUSE), resident("Elsewhere", ADMIN, "house-second")];
    expect(placeholderNames(ADMIN)).toEqual(["Mine"]);
  });

  it("a co-manager with an accepted Communication grant sees the granted house's residents", () => {
    select([workspace(SEATTLE_WS, AMBIKA, false, [SEATTLE_HOUSE])], SEATTLE_WS);
    state.invites = [
      {
        id: "link-1",
        status: "accepted",
        direction: "incoming",
        assignedPropertyIds: [SEATTLE_HOUSE],
        propertyCoManagerPermissions: { [SEATTLE_HOUSE]: { inbox: { read: true } } },
      },
    ];
    state.rows = [resident("Khue", AMBIKA, SEATTLE_HOUSE)];
    expect(placeholderNames(CO)).toEqual(["Khue"]);
  });

  it("a cancelled grant sees none of them", () => {
    select([workspace(SEATTLE_WS, AMBIKA, false, [SEATTLE_HOUSE])], SEATTLE_WS);
    state.invites = [
      {
        id: "link-1",
        status: "cancelled",
        direction: "incoming",
        assignedPropertyIds: [SEATTLE_HOUSE],
        propertyCoManagerPermissions: { [SEATTLE_HOUSE]: { inbox: { read: true } } },
      },
    ];
    state.rows = [resident("Khue", AMBIKA, SEATTLE_HOUSE)];
    expect(placeholderNames(CO)).toEqual([]);
  });

  it("a grant without Communication on the house lists nobody from it", () => {
    select([workspace(SEATTLE_WS, AMBIKA, false, [SEATTLE_HOUSE])], SEATTLE_WS);
    state.invites = [
      {
        id: "link-1",
        status: "accepted",
        direction: "incoming",
        assignedPropertyIds: [SEATTLE_HOUSE],
        propertyCoManagerPermissions: { [SEATTLE_HOUSE]: { residents: { read: true } } },
      },
    ];
    state.rows = [resident("Khue", AMBIKA, SEATTLE_HOUSE)];
    expect(placeholderNames(CO)).toEqual([]);
  });

  it("no viewer id lists no residents", () => {
    select([workspace(MINE_WS, ADMIN, true, [OWN_HOUSE])], MINE_WS);
    state.rows = [resident("Mine", ADMIN, OWN_HOUSE)];
    expect(buildManagerInboxLiveContacts(null).filter((c) => c.role === "resident")).toEqual([]);
  });
});

describe("dismissed empty chats", () => {
  it("a dismissed contact's placeholder is gone and the others stay", () => {
    select([workspace(MINE_WS, ADMIN, true, [OWN_HOUSE])], MINE_WS);
    state.rows = [resident("Mine", ADMIN, OWN_HOUSE), resident("Other", ADMIN, OWN_HOUSE)];
    expect(placeholderNames(ADMIN, ["mine@example.test"])).toEqual(["Other"]);
  });

  it("a dismissal never hides a person who has a live conversation", () => {
    select([workspace(MINE_WS, ADMIN, true, [OWN_HOUSE])], MINE_WS);
    state.rows = [resident("Mine", ADMIN, OWN_HOUSE)];
    const contacts = buildManagerInboxLiveContacts(ADMIN);
    // The live thread is a different row (never built here); the placeholder builder simply
    // leaves the person out in both cases, and the dismissal is not consulted for the live row.
    const items = buildResidentPlaceholderInboxItems({
      contacts,
      filters: EMPTY_COMMUNICATION_THREAD_FILTERS,
      occupiedEmails: new Set(["mine@example.test"]),
      listSegment: "active",
      dismissedKeys: new Set(["mine@example.test"]),
    });
    expect(items).toEqual([]);
    expect(contacts.map((c) => c.email)).toContain("mine@example.test");
  });
});
