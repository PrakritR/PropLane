import { redirect } from "next/navigation";

/** `/rent/tours` is the tour page under its older name; the query (propertyId, tab, ...) rides along. */
export default async function ToursRedirectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const entry of Array.isArray(value) ? value : value === undefined ? [] : [value]) params.append(key, entry);
  }
  const query = params.toString();
  redirect(query ? `/rent/tours-contact?${query}` : "/rent/tours-contact");
}
