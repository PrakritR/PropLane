import { renderProPortalSection } from "@/lib/render-portal-section/manager";

export default async function ServicesVendorsPage() {
  return renderProPortalSection("services", ["vendors"]);
}
