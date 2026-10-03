import Link from "next/link";

export default async function ShortStayConfirmationPage({
  searchParams,
}: {
  searchParams: Promise<{ request?: string; propertyId?: string; bookingId?: string }>;
}) {
  const params = await searchParams;
  const isRequest = params.request === "1";
  const propertyId = params.propertyId?.trim() ?? "";

  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4 px-4 py-10" data-st9-done>
      <h1 className="text-xl font-bold text-foreground">{isRequest ? "Request sent" : "You’re booked"}</h1>
      <p className="text-sm text-foreground">
        {isRequest
          ? "The manager reviews your request. You pay only if it is approved."
          : "Payment confirmation will arrive by email when checkout completes."}
      </p>
      {propertyId ? (
        <Link
          href={`/rent/listings/${encodeURIComponent(propertyId)}`}
          className="text-sm font-semibold text-primary"
        >
          Back to listing
        </Link>
      ) : (
        <Link href="/rent/browse" className="text-sm font-semibold text-primary">Back to browse</Link>
      )}
    </div>
  );
}
