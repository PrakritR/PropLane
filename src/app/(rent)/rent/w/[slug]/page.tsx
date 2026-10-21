import { notFound } from "next/navigation";
import { Suspense } from "react";
import { WorkspaceBrowsePageClient } from "@/components/marketing/workspace-browse-page-client";
import { resolveWorkspaceBrowseListings } from "@/lib/workspace-browse.server";
import { WORKSPACE_BROWSE_LIST_PARAM } from "@/lib/workspace-browse-links";

type PageProps = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
};

export default async function WorkspaceBrowsePage({ params, searchParams }: PageProps) {
  const { slug } = await params;
  const sp = await searchParams;
  const rawList = sp[WORKSPACE_BROWSE_LIST_PARAM];
  const listParam = Array.isArray(rawList) ? rawList[0] : rawList;
  const resolved = await resolveWorkspaceBrowseListings(slug, listParam ?? null);
  if (!resolved.ok) notFound();

  return (
    <Suspense
      fallback={<div className="flex min-h-[50vh] items-center justify-center text-sm text-muted">Loading…</div>}
    >
      <WorkspaceBrowsePageClient
        workspaceName={resolved.workspaceName}
        propertyIds={resolved.propertyIds}
      />
    </Suspense>
  );
}
