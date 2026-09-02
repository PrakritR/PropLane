import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { DEFAULT_MANAGER_AUTOMATION_SETTINGS } from "@/lib/payment-automation-settings";

vi.mock("@/lib/payment-automation-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/payment-automation-settings")>();
  return { ...actual, loadManagerAutomationSettings: vi.fn() };
});

vi.mock("@/lib/sms/manager-number-provisioning.server", () => ({
  resolveActiveManagerSendNumber: vi.fn(),
}));

vi.mock("@/lib/sms-consent", () => ({
  isPhoneOptedOut: vi.fn().mockResolvedValue(false),
}));

import { loadManagerAutomationSettings } from "@/lib/payment-automation-settings";
import { resolveActiveManagerSendNumber } from "@/lib/sms/manager-number-provisioning.server";
import { resolveManagerNotificationChannels } from "@/lib/manager-notification-routing.server";

const db = {} as SupabaseClient;
const profile = {
  phone: "+13175550123",
  phone_verified_at: "2026-09-01T00:00:00.000Z",
  sms_from_number: "+18559168031",
  sms_forward_inbound: true,
};

describe("resolveManagerNotificationChannels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadManagerAutomationSettings).mockResolvedValue(
      DEFAULT_MANAGER_AUTOMATION_SETTINGS,
    );
  });

  it("never texts an unverified personal phone", async () => {
    vi.mocked(loadManagerAutomationSettings).mockResolvedValue({
      ...DEFAULT_MANAGER_AUTOMATION_SETTINGS,
      managerNotificationDestination: "personal_number",
    });
    vi.mocked(resolveActiveManagerSendNumber).mockResolvedValue("+18559168031");

    await expect(
      resolveManagerNotificationChannels(db, "manager-1", "maintenance", {
        ...profile,
        phone_verified_at: null,
      }),
    ).resolves.toMatchObject({ inbox: true, sms: false, fellBackToAssistant: true });
  });

  it("uses Assistant by default", async () => {
    vi.mocked(resolveActiveManagerSendNumber).mockResolvedValue(null);

    await expect(
      resolveManagerNotificationChannels(db, "manager-1", "maintenance", profile),
    ).resolves.toMatchObject({ inbox: true, sms: false, fellBackToAssistant: false });
  });

  it("switches the default route to manager-cell SMS when the work number is active", async () => {
    vi.mocked(loadManagerAutomationSettings).mockResolvedValue({
      ...DEFAULT_MANAGER_AUTOMATION_SETTINGS,
      managerNotificationDestination: "personal_number",
    });
    vi.mocked(resolveActiveManagerSendNumber).mockResolvedValue("+18559168031");

    await expect(
      resolveManagerNotificationChannels(db, "manager-1", "maintenance", profile),
    ).resolves.toMatchObject({ inbox: false, sms: true, fellBackToAssistant: false });
  });

  it("keeps Assistant when the selected topic is not enabled for texting", async () => {
    vi.mocked(loadManagerAutomationSettings).mockResolvedValue({
      ...DEFAULT_MANAGER_AUTOMATION_SETTINGS,
      managerNotificationDestination: "personal_number",
      managerNotificationCategories: {
        ...DEFAULT_MANAGER_AUTOMATION_SETTINGS.managerNotificationCategories,
        maintenance: false,
      },
    });
    vi.mocked(resolveActiveManagerSendNumber).mockResolvedValue("+18559168031");

    await expect(
      resolveManagerNotificationChannels(db, "manager-1", "maintenance", profile),
    ).resolves.toMatchObject({ inbox: true, sms: false, fellBackToAssistant: true });
  });

  it("returns no proactive channels when no updates is selected", async () => {
    vi.mocked(loadManagerAutomationSettings).mockResolvedValue({
      ...DEFAULT_MANAGER_AUTOMATION_SETTINGS,
      managerNotificationDestination: "none",
    });

    await expect(
      resolveManagerNotificationChannels(db, "manager-1", "leasing", profile),
    ).resolves.toMatchObject({ inbox: false, sms: false, fellBackToAssistant: false });
    expect(resolveActiveManagerSendNumber).not.toHaveBeenCalled();
  });
});
