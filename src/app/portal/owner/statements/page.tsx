import { OwnerStatementsPage } from "@/components/owner/owner-statements";
import { requireOwnerPage } from "@/lib/property-owner/page-guard.server";

export const metadata = { title: "Statements" };

export default async function OwnerStatementsRoute() {
  await requireOwnerPage();
  return <OwnerStatementsPage />;
}
