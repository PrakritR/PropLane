import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  stage: vi.fn(),
  upsert: vi.fn(),
  isDemoModeActive: vi.fn(),
}));
vi.mock("@/lib/portal-inbox-storage", () => ({
  MANAGER_INBOX_STORAGE_KEY: "manager",
  loadPersistedInbox: mocks.load,
  stagePersistedInboxRows: mocks.stage,
  upsertPersistedInboxRows: mocks.upsert,
  deleteInboxThreadIds: vi.fn(),
  changePersistedInboxThreadFolders: vi.fn(),
}));
vi.mock("@/lib/demo/demo-session", () => ({ isDemoModeActive: mocks.isDemoModeActive }));

import { archivePlaceholderContactThread } from "@/lib/communication-inbox-thread-mutations";
import { contactArchiveThreadId } from "@/lib/communication-resident-placeholders";

const contact = { id: "contact-1", email: "Resident@Example.com", name: "Res Ident" };

describe("archivePlaceholderContactThread (PRP follow-up item 6: placeholder rows stay archived)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isDemoModeActive.mockReturnValue(false);
  });

  it("creates an already-archived thread for a resident-directory placeholder and persists it", async () => {
    mocks.load.mockReturnValue([]);
    mocks.upsert.mockResolvedValue(true);

    const result = await archivePlaceholderContactThread("manager", contact);

    const id = contactArchiveThreadId("contact-1");
    expect(result.ok).toBe(true);
    expect(result.next[0]).toMatchObject({
      id,
      folder: "trash",
      previousFolder: "sent",
      email: "resident@example.com",
      messages: [],
    });
    expect(mocks.upsert).toHaveBeenCalledWith(
      "manager",
      [expect.objectContaining({ id, folder: "trash" })],
      result.next,
    );
  });

  it("is a no-op when a real thread already exists for that contact (never a duplicate row)", async () => {
    const existingId = contactArchiveThreadId("contact-1");
    const existing = [{ id: existingId, folder: "trash" as const }];
    mocks.load.mockReturnValue(existing);

    const result = await archivePlaceholderContactThread("manager", contact);

    expect(result.ok).toBe(true);
    expect(result.next).toBe(existing);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("rolls back the optimistic row when the backend upsert fails (PLAN B3)", async () => {
    const prev = [{ id: "other", folder: "inbox" as const }];
    mocks.load.mockReturnValue(prev);
    mocks.upsert.mockResolvedValue(false);

    const result = await archivePlaceholderContactThread("manager", contact);

    expect(result.ok).toBe(false);
    expect(result.next).toEqual(prev);
    expect(mocks.stage).toHaveBeenLastCalledWith("manager", prev);
  });

  it("stages locally with no network call in demo mode", async () => {
    mocks.isDemoModeActive.mockReturnValue(true);
    mocks.load.mockReturnValue([]);

    const result = await archivePlaceholderContactThread("manager", contact);

    expect(result.ok).toBe(true);
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.stage).toHaveBeenCalledWith("manager", result.next);
  });

  it("changes nothing for a contact with a blank email or id", async () => {
    mocks.load.mockReturnValue([]);

    const result = await archivePlaceholderContactThread("manager", { id: " ", email: "  " });

    expect(result.ok).toBe(true);
    expect(mocks.upsert).not.toHaveBeenCalled();
    expect(mocks.stage).not.toHaveBeenCalled();
  });
});
