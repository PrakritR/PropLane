import { SharedApplicationPage } from "@/components/public/shared-record-page";

// A share URL is unguessable, so this is not an enumeration risk — but a link that leaks into any
// crawlable surface (a pasted email thread, a support ticket, a chat export) would otherwise be
// indexed for the life of the token, long outliving the moment it was shared.
export const metadata = { robots: { index: false, follow: false } };


export default function Page() {
  return <SharedApplicationPage />;
}
