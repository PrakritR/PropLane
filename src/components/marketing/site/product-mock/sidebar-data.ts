/**
 * What the demo window's sidebar counts at a point in the story: the count badges on its rows, read off
 * the same rows the panels draw (`world.ts`), never typed beside them.
 */

import { phoneScriptFor } from "@/components/marketing/resident-lifecycle-script";
import { COMM_CONVERSATIONS } from "@/components/marketing/site/product-mock/fixtures";
import type { DemoPortal } from "@/components/marketing/site/product-mock/demo-nav";
import { residentConversations, vendorConversations, worldFor, type DemoStory } from "@/components/marketing/site/product-mock/world";

export function demoSidebar(
  portal: DemoPortal,
  story: DemoStory,
  stage: string,
): { badges: Record<string, number> } {
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
    };
  }
  if (portal === "resident") {
    const rows = residentConversations(story, phoneScriptFor("resident", stage).items);
    const rentDue = story.leaseStep === 3 && !story.rentPaid;
    return {
      badges: { communication: rows.filter((row) => row.segment === "active" && row.unread).length, payments: rentDue ? 1 : 0 },
    };
  }
  const rows = vendorConversations(phoneScriptFor("vendor", stage).items);
  return {
    badges: { communication: rows.filter((row) => row.segment === "active" && row.unread).length },
  };
}
