import { OwnerFinancesPage } from "@/components/owner/owner-finances";
import { requireManagedOwnerPage } from "@/lib/managed-finance/page-guard.server";

export const metadata = { title: "Finances" };

export default async function OwnerFinancesRoute() {
  await requireManagedOwnerPage();
  return <OwnerFinancesPage />;
}
