import { OwnerMessagesPage } from "@/components/owner/owner-messages";
import { requireOwnerPage } from "@/lib/property-owner/page-guard.server";

export const metadata = { title: "Messages" };

export default async function OwnerMessagesRoute() {
  await requireOwnerPage("messages");
  return <OwnerMessagesPage />;
}
