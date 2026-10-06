import { PublicServicePage } from "@/components/public/public-service-page";

// A texted service link is a bearer link: it must never land in a search index, for the life of
// the token or after.
export const metadata = { title: "Job on PropLane", robots: { index: false, follow: false } };

export default function Page() {
  return <PublicServicePage />;
}
