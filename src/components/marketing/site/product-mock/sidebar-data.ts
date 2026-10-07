/**
 * What the demo window's sidebar counts and lists at a point in the story: the count badges on its rows
 * and the real sidebar's "Conversations" group. Both are read off the same rows the panels draw
 * (`world.ts`), never typed beside them.
 */

import { phoneScriptFor } from "@/components/marketing/resident-lifecycle-script";
import type { SidebarConversation } from "@/components/marketing/resident-lifecycle-workspace";
import type { CommConversationFixture } from "@/components/marketing/site/product-mock/fixtures";
import { COMM_CONVERSATIONS } from "@/components/marketing/site/product-mock/fixtures";
import type { DemoPortal } from "@/components/marketing/site/product-mock/demo-nav";
import { residentConversations, vendorConversations, worldFor, type DemoStory } from "@/components/marketing/site/product-mock/world";

function initials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toUpperCase();
  return (words[0]![0]! + words[1]![0]!).toUpperCase();
}

function toSidebar(rows: CommConversationFixture[]): SidebarConversation[] {
  return rows
    .filter((row) => row.segment === "active")
    .slice(0, 5)
    .map((row) => ({ id: row.id, name: row.name, initials: initials(row.name), unread: row.unread === true }));
}

export function demoSidebar(
  portal: DemoPortal,
  story: DemoStory,
  stage: string,
): { badges: Record<string, number>; conversations: SidebarConversation[] } {
  if (portal === "manager") {
    const world = worldFor(story);
    const rows = COMM_CONVERSATIONS;
    return {
      badges: {
        communication: rows.filter((row) => row.segment === "active" && row.unread).length,
        tours: world.badges.tours,
        applications: world.badges.applications,
        leases: world.badges.leases,
        services: world.badges.services,
        payments: world.badges.payments,
      },
      conversations: toSidebar(rows),
    };
  }
  if (portal === "resident") {
    const rows = residentConversations(story, phoneScriptFor("resident", stage).items);
    const rentDue = story.leaseStep === 3 && !story.rentPaid;
    return {
      badges: { communication: rows.filter((row) => row.segment === "active" && row.unread).length, payments: rentDue ? 1 : 0 },
      conversations: toSidebar(rows),
    };
  }
  const rows = vendorConversations(phoneScriptFor("vendor", stage).items);
  return {
    badges: { communication: rows.filter((row) => row.segment === "active" && row.unread).length },
    conversations: toSidebar(rows),
  };
}
