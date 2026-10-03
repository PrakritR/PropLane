import Link from "next/link";

export default function ShortStayConfirmationPage() {
  return (
    <div className="mx-auto flex w-full max-w-lg flex-col gap-4 px-4 py-10">
      <h1 className="text-xl font-bold text-foreground">Stay request received</h1>
      <p className="text-sm text-foreground">
        We saved your booking details. Payment confirmation will arrive by email when checkout completes.
      </p>
      <Link href="/rent/browse" className="text-sm font-semibold text-primary">Back to browse</Link>
    </div>
  );
}
