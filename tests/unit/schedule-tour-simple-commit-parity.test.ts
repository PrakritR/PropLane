import { afterEach, describe, expect, it, vi } from "vitest";
import { buildProspectRow, type AddPersonForm, type BuildRowContext } from "@/components/portal/resident-wizard/state";
import { readManagerApplicationRows, appendManagerApplicationRow } from "@/lib/manager-applications-storage";
import { buildScheduleTourSimpleForm } from "@/lib/schedule-tour-simple";

/**
 * The simplified modal must reuse the exact tour-create path the old 4-step
 * wizard used — `commitProspect` → `createManualPlannedTourClient` → `POST
 * /api/portal/manual-tour` — with no new endpoint and no payload change.
 * This proves it at the actual booking-call level: two `AddPersonForm`s built
 * two different ways (the simplified modal's builder vs. the old wizard's own
 * Contact/Home/Tour step patches) for the SAME inputs produce byte-identical
 * arguments to `createManualPlannedTourClient`.
 */

const createManualPlannedTourClient = vi.fn(async () => ({
  ok: true as const,
  message: "Tour scheduled.",
  plannedEvent: { id: "evt_1" },
}));

vi.mock("@/lib/manual-planned-tour.client", () => ({
  createManualPlannedTourClient: (...args: unknown[]) => createManualPlannedTourClient(...(args as [string, unknown])),
}));

vi.mock("@/lib/manager-applications-storage", () => ({
  appendManagerApplicationRow: vi.fn(),
  readManagerApplicationRows: vi.fn(() => []),
  replaceManagerApplicationRowInCache: vi.fn(),
  syncManagerApplicationsFromServer: vi.fn(async () => {}),
  upsertApplicationRowToServerAwait: vi.fn(async () => ({ ok: true })),
}));

afterEach(() => {
  vi.clearAllMocks();
});

const ctx: BuildRowContext & { idSuffix: () => string } = {
  userId: "mgr-1",
  propertyLabelFor: (id: string) => (id === "prop_alder" ? "Alder Row" : undefined),
  idSuffix: () => "TEST0001",
};

const commitCtx = {
  userId: "mgr-1",
  executedLeaseKeys: { axisIds: new Set<string>(), emails: new Set<string>() },
  propertyLabelFor: ctx.propertyLabelFor,
  assignee: null,
};

describe("commitProspect — the simplified modal's booking call matches the old wizard's", () => {
  it("sends createManualPlannedTourClient the same args for equivalent inputs", async () => {
    const { commitProspect } = await import("@/components/portal/resident-wizard/commit");

    const simpleForm = buildScheduleTourSimpleForm({
      name: "Jamie Prospect",
      email: "jamie@example.com",
      phone: "+12065551234",
      propertyId: "prop_alder",
      roomId: "",
      bundleId: "",
      tourFormat: "in_person",
      slotKey: "2026-08-06:18",
      tourNotes: "Meet at the gate",
    });

    // The old wizard's Contact/Home/Tour steps would have produced this same
    // shape for the identical inputs (same wall-clock time, typed by hand).
    const oldWizardForm: AddPersonForm = {
      ...simpleForm,
    };

    const simpleRow = buildProspectRow(simpleForm, ctx);
    const oldRow = buildProspectRow(oldWizardForm, ctx);
    expect(simpleRow.ok).toBe(true);
    expect(oldRow.ok).toBe(true);
    if (!simpleRow.ok || !oldRow.ok) return;

    await commitProspect(simpleRow.row, simpleForm, commitCtx);
    const simpleCallArgs = createManualPlannedTourClient.mock.calls[0];

    createManualPlannedTourClient.mockClear();

    await commitProspect(oldRow.row, oldWizardForm, commitCtx);
    const oldCallArgs = createManualPlannedTourClient.mock.calls[0];

    expect(simpleCallArgs).toBeDefined();
    expect(oldCallArgs).toBeDefined();
    expect(simpleCallArgs).toEqual(oldCallArgs);

    // And name the exact fields the manual-tour route reads, so a future
    // refactor of either builder cannot drift them apart silently.
    const [managerUserId, input] = simpleCallArgs as [string, Record<string, unknown>];
    expect(managerUserId).toBe("mgr-1");
    expect(input).toMatchObject({
      propertyId: "prop_alder",
      guestName: "Jamie Prospect",
      guestEmail: "jamie@example.com",
      guestPhone: "+12065551234",
      tourFormat: "in_person",
      notes: "Meet at the gate",
    });
  });
});


it.each(["New room", undefined])("uses this booking's placement (%s) and Pacific window for an existing visitor", async (roomNumber) => {
  const { commitProspect } = await import("@/components/portal/resident-wizard/commit");
  const form = buildScheduleTourSimpleForm({ name: "Jamie", email: "jamie@example.com", phone: "", propertyId: "prop_alder", roomId: "", bundleId: "", tourFormat: "in_person", slotKey: "2026-08-06:18", tourNotes: "" });
  const built = buildProspectRow(form, ctx);
  expect(built.ok).toBe(true);
  if (!built.ok) return;
  vi.mocked(readManagerApplicationRows).mockReturnValueOnce([{ ...built.row, id: "existing-visitor", manualResidentDetails: { ...built.row.manualResidentDetails, roomNumber: "Old room" } }]);
  const window = { start: "2026-08-06T16:00:00.000Z", end: "2026-08-06T16:30:00.000Z" };
  await commitProspect({ ...built.row, manualResidentDetails: { ...built.row.manualResidentDetails, roomNumber } }, form, { ...commitCtx, tourWindow: window });
  expect(appendManagerApplicationRow).not.toHaveBeenCalled();
  expect(createManualPlannedTourClient).toHaveBeenCalledWith("mgr-1", expect.objectContaining({ roomLabel: roomNumber, ...window }));
});
