import { describe, expect, it, vi } from "vitest";
import {
  resolvePropertyLeadRecipientIds,
  resolvePropertyScopedManagerRecipientIds,
} from "@/lib/co-manager-notification-recipients.server";

describe("resolvePropertyScopedManagerRecipientIds", () => {
  it("returns only the owner when propertyId is omitted", async () => {
    const db = {
      from: vi.fn(),
    } as unknown as Parameters<typeof resolvePropertyScopedManagerRecipientIds>[0];

    await expect(
      resolvePropertyScopedManagerRecipientIds(db, {
        ownerManagerUserId: "owner-1",
        channel: "inbox",
      }),
    ).resolves.toEqual(["owner-1"]);
    expect(db.from).not.toHaveBeenCalled();
  });

  it("includes co-managers with inbox access on the property", async () => {
    const db = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(async () => ({
              data: [
                {
                  invitee_user_id: "co-1",
                  assigned_property_ids: ["prop-a"],
                  property_co_manager_permissions: { "prop-a": { inbox: true } },
                },
                {
                  invitee_user_id: "co-2",
                  assigned_property_ids: ["prop-a"],
                  property_co_manager_permissions: { "prop-a": { calendar: true } },
                },
              ],
              error: null,
            })),
          })),
        })),
      })),
    } as unknown as Parameters<typeof resolvePropertyScopedManagerRecipientIds>[0];

    await expect(
      resolvePropertyScopedManagerRecipientIds(db, {
        ownerManagerUserId: "owner-1",
        propertyId: "prop-a",
        channel: "inbox",
      }),
    ).resolves.toEqual(["owner-1", "co-1"]);
  });

  it("includes co-managers with services access on the property", async () => {
    const db = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(async () => ({
              data: [
                {
                  invitee_user_id: "co-services",
                  assigned_property_ids: ["prop-a"],
                  property_co_manager_permissions: { "prop-a": { services: true } },
                },
                {
                  invitee_user_id: "co-inbox-only",
                  assigned_property_ids: ["prop-a"],
                  property_co_manager_permissions: { "prop-a": { inbox: true } },
                },
              ],
              error: null,
            })),
          })),
        })),
      })),
    } as unknown as Parameters<typeof resolvePropertyScopedManagerRecipientIds>[0];

    await expect(
      resolvePropertyScopedManagerRecipientIds(db, {
        ownerManagerUserId: "owner-1",
        propertyId: "prop-a",
        channel: "services",
      }),
    ).resolves.toEqual(["owner-1", "co-services"]);
  });

  it("unions inbox and calendar co-managers for property leads", async () => {
    const linkRows = [
      {
        invitee_user_id: "co-inbox",
        assigned_property_ids: ["prop-a"],
        property_co_manager_permissions: { "prop-a": { inbox: true } },
      },
      {
        invitee_user_id: "co-calendar",
        assigned_property_ids: ["prop-a"],
        property_co_manager_permissions: { "prop-a": { calendar: true } },
      },
      {
        invitee_user_id: "co-both",
        assigned_property_ids: ["prop-a"],
        property_co_manager_permissions: { "prop-a": { inbox: true, calendar: true } },
      },
    ];
    const db = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(async () => ({ data: linkRows, error: null })),
          })),
        })),
      })),
    } as unknown as Parameters<typeof resolvePropertyLeadRecipientIds>[0];

    const result = await resolvePropertyLeadRecipientIds(db, {
      ownerManagerUserId: "owner-1",
      propertyId: "prop-a",
    });
    expect(result.sort()).toEqual(["co-both", "co-calendar", "co-inbox", "owner-1"]);
  });
});
