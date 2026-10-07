import { OwnerDocumentsPage } from "@/components/owner/owner-documents";
import { requireOwnerPage } from "@/lib/property-owner/page-guard.server";

export const metadata = { title: "Documents" };

export default async function OwnerDocumentsRoute() {
  await requireOwnerPage();
  return <OwnerDocumentsPage />;
}
