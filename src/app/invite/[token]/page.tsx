import { Suspense } from "react";
import InviteLinkClient from "./invite-link-client";

/** Token is a path segment and the page reads a session, so never prerender. */
export const dynamic = "force-dynamic";

export default async function InviteLinkPage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;
  return (
    <Suspense fallback={null}>
      <InviteLinkClient token={token} />
    </Suspense>
  );
}
