import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DemoApplicantRow } from "@/data/demo-portal";

const { deliverExistingResidentWelcome, enqueueOwnerSms, resolveWorkspaceWorkNumbers, track } = vi.hoisted(() => ({
  deliverExistingResidentWelcome: vi.fn(),
  enqueueOwnerSms: vi.fn(),
  resolveWorkspaceWorkNumbers: vi.fn(),
  track: vi.fn(),
}));

vi.mock("@/lib/resident-welcome.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/resident-welcome.server")>()),
  deliverExistingResidentWelcome,
}));
vi.mock("@/lib/sms/owner-sms-dispatcher.server", () => ({ enqueueOwnerSms }));
vi.mock("@/lib/sms/manager-workspace-role.server", () => ({ resolveWorkspaceWorkNumbers }));
vi.mock("@/lib/analytics/posthog", () => ({ track }));

import { invitePortfolioImportResidents } from "@/lib/portfolio-import/invite.server";

type Row = Record<string, unknown>;

function fakeDb(applications: Row[], receipts: Row[]) {
  const updates: Array<{ id: string; patch: Row }> = [];
  return {
    _updates: updates,
    from(table: string) {
      if (table === "manager_portfolio_import_records") {
        return {
          select: () => ({
            eq: (col: string, val: unknown) => {
              const filtered = receipts.filter((r) => r[col] === val);
              return { then: (resolve: (v: unknown) => unknown) => Promise.resolve({ data: filtered, error: null }).then(resolve) };
            },
          }),
        };
      }
      if (table === "manager_application_records") {
        return {
          select: () => ({
            eq: (col1: string, val1: unknown) => ({
              eq: (col2: string, val2: unknown) => ({
                maybeSingle: async () => {
                  const row = applications.find((r) => r[col1] === val1 && r[col2] === val2);
                  return { data: row ?? null, error: null };
                },
              }),
            }),
          }),
          update: (patch: Row) => ({
            eq: (_col1: string, val1: unknown) => ({
              eq: async () => {
                const row = applications.find((r) => r.id === val1);
                if (row) Object.assign(row, patch);
                updates.push({ id: String(val1), patch });
                return { data: null, error: null };
              },
            }),
          }),
        };
      }
      throw new Error(`Unexpected table ${table}`);
    },
  };
}

function residentApplicationRow(overrides: Partial<DemoApplicantRow> = {}): Row {
  return {
    id: "PROPLANE-AAA111",
    manager_user_id: "mgr-1",
    row_data: {
      id: "PROPLANE-AAA111",
      name: "Alice Resident",
      email: "alice@test.proplane.local",
      property: "The Pioneer",
      stage: "Active",
      bucket: "approved",
      detail: "",
      manuallyAdded: true,
      manualResidentDetails: { phone: "+12065551234" },
      ...overrides,
    },
  };
}

describe("invitePortfolioImportResidents", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The invite step delivers the welcome itself and stamps the row afterwards,
    // so the delivery mock only reports success (a demo address is `skipped`,
    // i.e. inbox record only — still a send from the manager's point of view).
    deliverExistingResidentWelcome.mockResolvedValue({ ok: true, id: "welcome-1", skipped: true });
    enqueueOwnerSms.mockResolvedValue({ ok: true, outboxId: "sms-1", status: "queued", deduplicated: false });
    resolveWorkspaceWorkNumbers.mockResolvedValue({
      role: "primary",
      numbers: [{ ownerUserId: "mgr-1", ownerName: "Morgan Manager", phoneNumber: "+12065559999", provisionState: "active" }],
    });
  });

  it("sends both email and text when both channels are requested", async () => {
    const receipts = [{ import_id: "import-1", record_kind: "resident", source_key: "alice", status: "completed", canonical_id: "PROPLANE-AAA111" }];
    const applications = [residentApplicationRow()];
    const db = fakeDb(applications, receipts);

    const { results, workNumber } = await invitePortfolioImportResidents({
      db: db as never,
      managerUserId: "mgr-1",
      actor: { userId: "mgr-1", email: "m@test.proplane.local", managerName: "Morgan Manager" },
      importId: "import-1",
      residentKeys: ["alice"],
      channels: "both",
    });

    expect(workNumber).toBe("+12065559999");
    expect(results).toHaveLength(1);
    expect(results[0]?.email).toBe("sent");
    expect(results[0]?.text).toBe("sent");
    expect(deliverExistingResidentWelcome).toHaveBeenCalledTimes(1);
    expect(deliverExistingResidentWelcome.mock.calls[0]?.[2]).toMatchObject({ to: expect.any(String), axisId: expect.any(String) });
    expect(enqueueOwnerSms).toHaveBeenCalledTimes(1);
    const smsBody = (enqueueOwnerSms.mock.calls[0]?.[0] as { body: string }).body;
    expect(smsBody).toContain("Reply STOP to opt out.");
    expect(smsBody.match(/Reply STOP/g)?.length).toBe(1);
    expect(track).toHaveBeenCalledWith("portfolio_import_invites_sent", "mgr-1", { emailCount: 1, textCount: 1 });
  });

  it("texts a resident with no email, skipping the email channel", async () => {
    const receipts = [{ import_id: "import-1", record_kind: "resident", source_key: "noemail", status: "completed", canonical_id: "PROPLANE-BBB222" }];
    const applications = [
      residentApplicationRow({ id: "PROPLANE-BBB222" }),
    ];
    applications[0]!.id = "PROPLANE-BBB222";
    (applications[0]!.row_data as Row).id = "PROPLANE-BBB222";
    (applications[0]!.row_data as Row).email = "";
    const db = fakeDb(applications, receipts);

    const { results } = await invitePortfolioImportResidents({
      db: db as never,
      managerUserId: "mgr-1",
      actor: { userId: "mgr-1", email: "m@test.proplane.local" },
      importId: "import-1",
      residentKeys: ["noemail"],
      channels: "both",
    });

    expect(results[0]?.email).toBe("skipped_no_email");
    expect(results[0]?.text).toBe("sent");
    expect(deliverExistingResidentWelcome).not.toHaveBeenCalled();
    // Text-only send still stamps the welcome marker so a repeat invite reads already_sent.
    expect(db._updates).toHaveLength(1);
  });

  it("emails a resident with no phone, skipping the text channel", async () => {
    const receipts = [{ import_id: "import-1", record_kind: "resident", source_key: "nophone", status: "completed", canonical_id: "PROPLANE-CCC333" }];
    const applications = [residentApplicationRow({ id: "PROPLANE-CCC333" })];
    applications[0]!.id = "PROPLANE-CCC333";
    (applications[0]!.row_data as Row).id = "PROPLANE-CCC333";
    (applications[0]!.row_data as { manualResidentDetails?: Row }).manualResidentDetails = {};
    const db = fakeDb(applications, receipts);

    const { results } = await invitePortfolioImportResidents({
      db: db as never,
      managerUserId: "mgr-1",
      actor: { userId: "mgr-1", email: "m@test.proplane.local" },
      importId: "import-1",
      residentKeys: ["nophone"],
      channels: "both",
    });

    expect(results[0]?.email).toBe("sent");
    expect(results[0]?.text).toBe("skipped_no_phone");
    expect(enqueueOwnerSms).not.toHaveBeenCalled();
  });

  it("reports skipped_no_work_number when the manager has no active outbound number", async () => {
    resolveWorkspaceWorkNumbers.mockResolvedValue({ role: "primary", numbers: [{ ownerUserId: "mgr-1", ownerName: null, phoneNumber: null, provisionState: "pending_registration" }] });
    const receipts = [{ import_id: "import-1", record_kind: "resident", source_key: "alice", status: "completed", canonical_id: "PROPLANE-AAA111" }];
    const applications = [residentApplicationRow()];
    const db = fakeDb(applications, receipts);

    const { results, workNumber } = await invitePortfolioImportResidents({
      db: db as never,
      managerUserId: "mgr-1",
      actor: { userId: "mgr-1", email: "m@test.proplane.local" },
      importId: "import-1",
      residentKeys: ["alice"],
      channels: "text",
    });

    expect(workNumber).toBeNull();
    expect(results[0]?.text).toBe("skipped_no_work_number");
    expect(enqueueOwnerSms).not.toHaveBeenCalled();
  });

  it("reports already_sent on a second invite call", async () => {
    const receipts = [{ import_id: "import-1", record_kind: "resident", source_key: "alice", status: "completed", canonical_id: "PROPLANE-AAA111" }];
    const applications = [residentApplicationRow()];
    const db = fakeDb(applications, receipts);

    await invitePortfolioImportResidents({
      db: db as never,
      managerUserId: "mgr-1",
      actor: { userId: "mgr-1", email: "m@test.proplane.local" },
      importId: "import-1",
      residentKeys: ["alice"],
      channels: "both",
    });

    // Second call reads the stamped row the first call wrote through the fake db;
    // the pre-send guard short-circuits both channels.
    deliverExistingResidentWelcome.mockClear();
    enqueueOwnerSms.mockClear();

    const { results } = await invitePortfolioImportResidents({
      db: db as never,
      managerUserId: "mgr-1",
      actor: { userId: "mgr-1", email: "m@test.proplane.local" },
      importId: "import-1",
      residentKeys: ["alice"],
      channels: "both",
    });

    expect(results[0]?.email).toBe("already_sent");
    expect(results[0]?.text).toBe("already_sent");
    expect(deliverExistingResidentWelcome).not.toHaveBeenCalled();
    expect(enqueueOwnerSms).not.toHaveBeenCalled();
  });

  it("uses a stable dedupe key per import+resident", async () => {
    const receipts = [{ import_id: "import-1", record_kind: "resident", source_key: "alice", status: "completed", canonical_id: "PROPLANE-AAA111" }];
    const applications = [residentApplicationRow()];
    const db = fakeDb(applications, receipts);

    await invitePortfolioImportResidents({
      db: db as never,
      managerUserId: "mgr-1",
      actor: { userId: "mgr-1", email: "m@test.proplane.local" },
      importId: "import-1",
      residentKeys: ["alice"],
      channels: "text",
    });

    expect((enqueueOwnerSms.mock.calls[0]?.[0] as { dedupeKey: string }).dedupeKey).toBe("welcome:import:import-1:alice");
  });
});
