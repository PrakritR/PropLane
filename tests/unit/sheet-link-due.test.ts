import { describe, expect, it } from "vitest";

import {
  normalizeManagerSheetBinding,
  sheetLinkDueForSync,
  sheetLinkReadsLabel,
  sheetLinkStatus,
} from "@/lib/manager-sheet-link";

const now = new Date("2026-10-08T12:00:00.000Z");
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000).toISOString();

describe("sheetLinkDueForSync", () => {
  it("never syncs a manual link", () => {
    expect(sheetLinkDueForSync({ autoSync: true, refreshMinutes: null, lastSyncedAt: null }, now)).toBe(false);
    expect(sheetLinkDueForSync({ autoSync: false, refreshMinutes: 15, lastSyncedAt: null }, now)).toBe(false);
  });
  it("syncs a never-synced link", () => {
    expect(sheetLinkDueForSync({ autoSync: true, refreshMinutes: 60, lastSyncedAt: null }, now)).toBe(true);
  });
  it("treats a missing refreshMinutes as 15", () => {
    expect(sheetLinkDueForSync({ autoSync: true, lastSyncedAt: ago(20) }, now)).toBe(true);
    expect(sheetLinkDueForSync({ autoSync: true, lastSyncedAt: ago(5) }, now)).toBe(false);
  });
  it("waits for the hourly interval", () => {
    expect(sheetLinkDueForSync({ autoSync: true, refreshMinutes: 60, lastSyncedAt: ago(30) }, now)).toBe(false);
    expect(sheetLinkDueForSync({ autoSync: true, refreshMinutes: 60, lastSyncedAt: ago(61) }, now)).toBe(true);
  });
  it("tolerates cron jitter of up to a minute", () => {
    expect(sheetLinkDueForSync({ autoSync: true, refreshMinutes: 15, lastSyncedAt: ago(14.5) }, now)).toBe(true);
    expect(sheetLinkDueForSync({ autoSync: true, refreshMinutes: 15, lastSyncedAt: ago(13) }, now)).toBe(false);
  });
});

describe("binding defaults", () => {
  it("defaults an existing link to google / occupancy / 15 minutes", () => {
    const b = normalizeManagerSheetBinding({ spreadsheetId: "abc", autoSync: true })!;
    expect([b.source, b.mode, b.refreshMinutes, b.autoSync]).toEqual(["google", "occupancy", 15, true]);
  });
  it("reads a bound stays tab as stays mode, and autoSync off as manual", () => {
    const b = normalizeManagerSheetBinding({ spreadsheetId: "abc", autoSync: false, staysTab: { gid: "1", title: "S" } })!;
    expect([b.mode, b.refreshMinutes, b.autoSync]).toEqual(["stays", null, false]);
  });
  it("keeps an explicit null refresh as manual", () => {
    const b = normalizeManagerSheetBinding({ spreadsheetId: "abc", refreshMinutes: null })!;
    expect([b.refreshMinutes, b.autoSync]).toEqual([null, false]);
  });
});

describe("sheetLinkStatus / sheetLinkReadsLabel", () => {
  it("is live, attention or manual", () => {
    const base = { autoSync: true, refreshMinutes: 15 as const, lastError: null };
    expect(sheetLinkStatus({ ...base, lastSyncedAt: ago(29) }, now)).toBe("live");
    expect(sheetLinkStatus({ ...base, lastSyncedAt: ago(31) }, now)).toBe("attention");
    expect(sheetLinkStatus({ ...base, lastSyncedAt: ago(1), lastError: "boom" }, now)).toBe("attention");
    expect(sheetLinkStatus({ ...base, autoSync: false, refreshMinutes: null, lastSyncedAt: ago(500) }, now)).toBe("manual");
  });
  it("labels what a sheet reads", () => {
    expect(sheetLinkReadsLabel({ mode: "occupancy", houseTabCount: 3, staysTab: null })).toBe("Occupancy + 3 house tabs");
    expect(sheetLinkReadsLabel({ mode: "occupancy", houseTabCount: 1, staysTab: { gid: "1", title: "S" } })).toBe(
      "Occupancy + 1 house tab + Stays",
    );
    expect(sheetLinkReadsLabel({ mode: "raw", houseTabCount: 0, staysTab: null })).toBe("Raw table");
  });
});
