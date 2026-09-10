/**
 * Route-level proof that an empty co-manager grant writes nothing.
 *
 * The gate these routes share used to read an assignment with no checked
 * permissions as full access. `describeCoManagerPermissions` would tell the
 * owner that delegate has "No access to any module", while the delegate could
 * still edit the owner's bills and edit or delete their private-bucket
 * documents on that property.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const createManagerBill = vi.fn();
const documentUpdates: Record<string, unknown>[] = [];

let userId = "delegate-1";
let linkRows: Array<{
  inviter_user_id: string;
  invitee_user_id: string;
  assigned_property_ids: string[];
  property_co_manager_permissions?: unknown;
}> = [];

const OWNER = "owner-1";
const DELEGATE = "delegate-1";
const PROPERTY = "prop-1";
const DOCUMENT_ID = "11111111-1111-4111-8111-111111111111";

function makeDb() {
  return {
    from(table: string) {
      const settle = () => {
        if (table === "account_link_invites") return { data: linkRows, error: null };
        if (table === "manager_documents") {
          return {
            data: {
              id: DOCUMENT_ID,
              manager_user_id: OWNER,
              property_id: PROPERTY,
              display_name: "Lease.pdf",
              visibility: "private",
            },
            error: null,
          };
        }
        return { data: { id: DELEGATE, email: "delegate@example.com" }, error: null };
      };
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        is: () => builder,
        in: async () => ({
          data: [
            { id: OWNER, email: "owner@example.com" },
            { id: DELEGATE, email: "delegate@example.com" },
          ],
        }),
        update: (values: Record<string, unknown>) => {
          documentUpdates.push(values);
          return builder;
        },
        maybeSingle: async () => settle(),
        then: (resolve: (v: unknown) => unknown) => Promise.resolve(settle()).then(resolve),
      };
      return builder;
    },
  };
}

vi.mock("@/lib/reports/auth", () => ({
  getReportsAuthContext: async () => ({ db: makeDb(), userId, role: "manager" }),
  assertManagerFinancialsAccess: async () => ({ ok: true }),
}));
vi.mock("@/lib/manager-bills.server", () => ({
  createManagerBill: (...a: unknown[]) => createManagerBill(...a),
}));
vi.mock("@/lib/analytics/posthog", () => ({ track: () => undefined }));
vi.mock("@/lib/documents/document-scope.server", () => ({
  managerOwnsVendorDirectoryRow: async () => true,
  resolveResidentUserIdByEmail: async () => null,
}));
vi.mock("@/lib/documents/document-share-notify.server", () => ({
  notifyDocumentShared: async () => undefined,
}));

const bills = await import("@/app/api/manager-bills/route");
const documents = await import("@/app/api/manager-documents/[id]/route");

function grant(permissions: unknown) {
  return [
    {
      inviter_user_id: OWNER,
      invitee_user_id: DELEGATE,
      assigned_property_ids: [PROPERTY],
      property_co_manager_permissions: permissions,
    },
  ];
}

function billRequest() {
  return new Request("http://localhost/api/manager-bills", {
    method: "POST",
    body: JSON.stringify({ description: "Roof", amountCents: 1000, propertyId: PROPERTY }),
  });
}

function documentRequest(body: Record<string, unknown>) {
  return new Request(`http://localhost/api/manager-documents/${DOCUMENT_ID}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

const params = { params: Promise.resolve({ id: DOCUMENT_ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  documentUpdates.length = 0;
  userId = DELEGATE;
  createManagerBill.mockResolvedValue({ id: "bill-1", amountCents: 1000 });
});

describe("an empty grant on the property", () => {
  beforeEach(() => {
    linkRows = grant({ [PROPERTY]: {} });
  });

  it("cannot create a bill against the owner's property", async () => {
    const res = await bills.POST(billRequest());

    expect(res.status).toBe(403);
    expect(createManagerBill).not.toHaveBeenCalled();
  });

  it("cannot rename the owner's document", async () => {
    const res = await documents.PATCH(documentRequest({ displayName: "Renamed.pdf" }), params);

    expect(res.status).toBe(404);
    expect(documentUpdates).toHaveLength(0);
  });

  it("cannot delete the owner's document", async () => {
    const res = await documents.DELETE(new Request("http://localhost/x", { method: "DELETE" }), params);

    expect(res.status).toBe(404);
    expect(documentUpdates).toHaveLength(0);
  });
});

describe("a read-only grant on the property", () => {
  beforeEach(() => {
    linkRows = grant({ [PROPERTY]: { financials: { read: true }, documents: { read: true } } });
  });

  it("cannot create a bill", async () => {
    const res = await bills.POST(billRequest());

    expect(res.status).toBe(403);
    expect(createManagerBill).not.toHaveBeenCalled();
  });

  it("cannot delete a document", async () => {
    const res = await documents.DELETE(new Request("http://localhost/x", { method: "DELETE" }), params);

    expect(res.status).toBe(404);
    expect(documentUpdates).toHaveLength(0);
  });
});

describe("a grant that names another property", () => {
  it("cannot create a bill against this one", async () => {
    linkRows = [
      {
        inviter_user_id: OWNER,
        invitee_user_id: DELEGATE,
        assigned_property_ids: ["prop-other"],
        property_co_manager_permissions: { "prop-other": { financials: { read: true, edit: true } } },
      },
    ];

    const res = await bills.POST(billRequest());

    expect(res.status).toBe(403);
    expect(createManagerBill).not.toHaveBeenCalled();
  });
});

describe("an explicit grant still works", () => {
  it("creates the bill with financials edit", async () => {
    linkRows = grant({ [PROPERTY]: { financials: { read: true, edit: true } } });

    const res = await bills.POST(billRequest());

    expect(res.status).toBe(200);
    expect(createManagerBill).toHaveBeenCalled();
  });

  it("renames the document with documents edit", async () => {
    linkRows = grant({ [PROPERTY]: { documents: { read: true, edit: true } } });

    const res = await documents.PATCH(documentRequest({ displayName: "Renamed.pdf" }), params);

    expect(res.status).toBe(200);
    expect(documentUpdates).toHaveLength(1);
  });

  it("lets the OWNER through with no link at all", async () => {
    linkRows = [];
    userId = OWNER;

    const res = await documents.DELETE(new Request("http://localhost/x", { method: "DELETE" }), params);

    expect(res.status).toBe(200);
    expect(documentUpdates).toHaveLength(1);
  });
});
