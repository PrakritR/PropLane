import { redirect } from "next/navigation";

export default function PropertyPortalServicesIndexPage() {
  redirect("/portal/services/work-orders/open");
}
