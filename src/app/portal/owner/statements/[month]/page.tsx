import { OwnerStatementDetail } from "@/components/owner/owner-statement-detail";
import { requireOwnerPage } from "@/lib/property-owner/page-guard.server";

export const metadata = { title: "Statement" };

export default async function OwnerStatementPage({ params }: { params: Promise<{ month: string }> }) {
  await requireOwnerPage();
  const { month } = await params;
  return <OwnerStatementDetail month={decodeURIComponent(month)} />;
}
