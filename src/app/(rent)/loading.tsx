export default function PublicLoading() {
  return (
    <div className="relative min-h-[55vh] flex-1">
      <div className="mx-auto max-w-6xl px-4 pt-16 text-center sm:px-5 sm:pt-20">
        <div className="mx-auto h-8 w-56 max-w-full animate-pulse rounded-full bg-accent/45" />
        <div className="mx-auto mt-8 h-24 w-full max-w-3xl animate-pulse rounded-2xl bg-accent/35" />
        <div className="mx-auto mt-5 h-5 w-full max-w-xl animate-pulse rounded-full bg-accent/30" />
        <div className="mx-auto mt-10 h-11 w-44 animate-pulse rounded-full bg-accent/40" />
      </div>
    </div>
  );
}
