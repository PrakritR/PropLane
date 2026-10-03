import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Captain, Oct 3: Settings -> Communication (the `messaging` pane) carries the
 * work identity only. No personal mobile row, no Reminders-and-messages entry.
 */
function messagingPaneSource(): string {
  const source = readFileSync("src/components/portal/portal-profile-client.tsx", "utf8");
  const start = source.indexOf("function ManagerMessagingSettingsPane()");
  const end = source.indexOf("\nfunction ", start + 1);
  expect(start).toBeGreaterThan(-1);
  return source.slice(start, end);
}

describe("Settings -> Communication pane", () => {
  it("mounts no personal phone block and no refresh wiring for one", () => {
    const pane = messagingPaneSource();
    expect(pane).not.toContain("PortalTextNotificationsBlock");
    expect(pane).not.toContain("Personal phone");
    expect(pane).not.toContain("personalPhoneRefreshKey");
    const client = readFileSync("src/components/portal/portal-profile-client.tsx", "utf8");
    expect(client).not.toContain("portal-text-notifications-block");
    expect(client).not.toContain("Personal mobile");
  });

  it("keeps What PropLane sends, the work identity panel and the approval switch", () => {
    const pane = messagingPaneSource();
    expect(pane).toContain("<ManagerMessagingSettingsPanel />");
    expect(pane).toContain("<WhatProplaneSends />");
    expect(pane).toContain("<AutoSendAiDraftsRow />");
  });

  it("the work identity panel no longer takes a personal-phone refresh key", () => {
    const panel = readFileSync("src/components/portal/pro-messaging-settings-panel.tsx", "utf8");
    expect(panel).not.toContain("personalPhoneRefreshKey");
  });

  it("the Communication settings panel has no Reminders and messages row", () => {
    const panels = readFileSync("src/components/portal/pro-portal-settings-panels.tsx", "utf8");
    expect(panels).not.toContain("communication-open-reminders-hub");
  });
});
