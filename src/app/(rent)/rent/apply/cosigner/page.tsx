import Link from "next/link";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { getPortalAccessContext, hasRole } from "@/lib/auth/portal-access";
import { listLinkedFormRequestsForResident } from "@/lib/application-linked-form-requests.server";
import { createSupabaseServiceRoleClient } from "@/lib/supabase/service";
import { linkedFormOpenPath } from "@/lib/linked-form-path";
import { parseCosignerSignerAppIdParam } from "@/lib/rental-application/cosigner-apply-link";

/** An old application-id URL can resume only a request already linked to this account. */
export default async function CosignerApplyPage({ searchParams }: { searchParams: Promise<{ signerAppId?: string }> }) {
  const { signerAppId } = await searchParams;
  const applicationId = parseCosignerSignerAppIdParam(signerAppId);
  const context = await getPortalAccessContext();
  if (context.user && hasRole(context, "resident") && applicationId) {
    const lists = await listLinkedFormRequestsForResident(createSupabaseServiceRoleClient(), { id: context.user.id, email: context.user.email });
    const matches = lists.helping.filter((form) => form.formKind === "application" && parseCosignerSignerAppIdParam(form.applicationId) === applicationId);
    if (matches.length === 1) redirect(linkedFormOpenPath(matches[0]!.id));
  }
  const here = `/rent/apply/cosigner${applicationId ? `?signerAppId=${encodeURIComponent(applicationId)}` : ""}`;
  return (
    <div className="mx-auto max-w-lg space-y-6 px-4 py-10">
      <h1 className="text-2xl font-bold">Co-signer application</h1>
      <p role="status">Ask the applicant for a new co-signer invitation from their resident portal.</p>
      {context.user ? <Button asChild><Link href="/resident/applications">Open my applications</Link></Button> : <div className="flex flex-wrap gap-3">
        <Button asChild><Link href={`/auth/sign-in?intent=resident&next=${encodeURIComponent(here)}`}>Sign in</Link></Button>
        <Button asChild variant="outline"><Link href={`/auth/create-account?mode=create&role=resident&next=${encodeURIComponent(here)}`}>Create resident account</Link></Button>
      </div>}
    </div>
  );
}
