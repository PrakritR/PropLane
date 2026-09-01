import { redirect } from "next/navigation";

export default function PropertyPortalServicesIndexPage() {
  redirect("/portal/services/requests/pending");
}
