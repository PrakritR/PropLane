import { describe, expect, it, vi } from "vitest";
import { createMemoryDb } from "./support/memory-supabase";

const notifyManager = vi.hoisted(() => vi.fn(async () => ({ delivered: true, suppressed: false })));
vi.mock("@/lib/agent-notify.server", () => ({ notifyManagerFromAgent: notifyManager }));
vi.mock("@/lib/work-number-recipients.server", () => ({ notifyWorkNumberRecipients: vi.fn(async () => undefined) }));

import {
  resolvePropertyLeadRecipientIds,
  notifyPropertyScopedManagersFromAgent,
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

  it("includes co-managers with notification access on the property", async () => {
    const db = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(async () => ({
              data: [
                {
                  invitee_user_id: "co-1",
                  assigned_property_ids: ["prop-a"],
                  property_co_manager_permissions: { "prop-a": { inbox: { read: true, notification: true } } },
                },
                {
                  invitee_user_id: "co-2",
                  assigned_property_ids: ["prop-a"],
                  property_co_manager_permissions: { "prop-a": { calendar: { read: true, notification: true } } },
                },
                {
                  invitee_user_id: "co-3",
                  assigned_property_ids: ["prop-a"],
                  property_co_manager_permissions: { "prop-a": { inbox: { read: true, notification: false } } },
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

  it("includes co-managers with services notification on the property", async () => {
    const db = {
      from: vi.fn(() => ({
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(async () => ({
              data: [
                {
                  invitee_user_id: "co-services",
                  assigned_property_ids: ["prop-a"],
                  property_co_manager_permissions: { "prop-a": { services: { notification: true } } },
                },
                {
                  invitee_user_id: "co-inbox-only",
                  assigned_property_ids: ["prop-a"],
                  property_co_manager_permissions: { "prop-a": { inbox: { notification: true } } },
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
        property_co_manager_permissions: { "prop-a": { calendar: { notification: true } } },
      },
      {
        invitee_user_id: "co-both",
        assigned_property_ids: ["prop-a"],
        property_co_manager_permissions: { "prop-a": { inbox: { notification: true }, calendar: { notification: true } } },
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

describe("notifyPropertyScopedManagersFromAgent — fans out by role", () => {
  const stamp = { inbox: { read: true, notification: true }, payments: { read: true, notification: true } };
  const invite = (id: string, role: string, over: Record<string, unknown> = {}) => ({
    inviter_user_id: "owner", invitee_user_id: id, status: "accepted", workspace_id: "ws-1", team_role: role,
    house_scope: "selected", assigned_property_ids: ["prop-a"], co_manager_permissions: stamp,
    property_co_manager_permissions: { "prop-a": stamp }, ...over,
  });
  const db = () =>
    createMemoryDb({
      portal_workspaces: [{ id: "ws-1", owner_user_id: "owner", name: "Seattle Homes", is_default: true }],
      manager_property_records: [{ id: "prop-a", manager_user_id: "owner", workspace_id: "ws-1", row_data: {} }],
      profiles: [],
      account_link_invites: [invite("pm", "property_manager"), invite("book", "bookkeeper"), invite("away", "viewer", { assigned_property_ids: ["prop-z"] })],
    });

  it("urgent: a house-less event reaches property managers, not just the owner", async () => {
    notifyManager.mockClear();
    await notifyPropertyScopedManagersFromAgent(db() as never, {
      ownerManagerUserId: "owner", module: "inbox", subject: "s", text: "t", idempotencyKey: "k1", urgent: true,
    });
    expect(notifyManager.mock.calls.map((c) => (c as unknown as [unknown, { landlordId: string }])[1].landlordId).sort()).toEqual(["away", "owner", "pm"]); // a viewer on another house still hears a no-house event
  });
  it("urgent: a payments event reaches the bookkeeper too, and a teammate off the house hears nothing", async () => {
    notifyManager.mockClear();
    await notifyPropertyScopedManagersFromAgent(db() as never, {
      ownerManagerUserId: "owner", propertyId: "prop-a", module: "payments", subject: "s", text: "t", idempotencyKey: "k2", urgent: true,
    });
    const landlords = notifyManager.mock.calls.map((c) => (c as unknown as [unknown, { landlordId: string }])[1].landlordId).sort();
    expect(landlords).toEqual(["book", "owner", "pm"]);
  });
  it("routine with a team line: only the owner's Assistant is noticed; teammates hear it from the Team chat line", async () => {
    notifyManager.mockClear();
    await notifyPropertyScopedManagersFromAgent(db() as never, {
      ownerManagerUserId: "owner", propertyId: "prop-a", module: "payments", subject: "s", text: "t", idempotencyKey: "k3",
      teamNotice: { text: "Payment · x · paid", messageId: "action-event:k3:team" },
    });
    const landlords = notifyManager.mock.calls.map((c) => (c as unknown as [unknown, { landlordId: string }])[1].landlordId);
    expect(landlords).toEqual(["owner"]);
  });
  it("urgent with a team line: every teammate with the house is still noticed directly", async () => {
    notifyManager.mockClear();
    await notifyPropertyScopedManagersFromAgent(db() as never, {
      ownerManagerUserId: "owner", propertyId: "prop-a", module: "payments", subject: "s", text: "t", idempotencyKey: "k4",
      urgent: true, teamNotice: { text: "Emergency · Payment · x · paid", messageId: "action-event:k4:team" },
    });
    const landlords = notifyManager.mock.calls.map((c) => (c as unknown as [unknown, { landlordId: string }])[1].landlordId).sort();
    expect(landlords).toEqual(["book", "owner", "pm"]);
  });
});
