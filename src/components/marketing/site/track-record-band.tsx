import { TRACK_RECORD, TRACK_RECORD_HOMES, trackRecordMetrics } from "@/lib/marketing/track-record";
import { cn } from "@/lib/utils";

/**
 * Twenty-eight rooms, twenty-six filled. Drawn from the same two constants as
 * the number beside it, so the picture can never disagree with the figure.
 */
export function OccupancyDots({ className }: { className?: string }) {
  const { roomsOccupied, roomsTotal } = TRACK_RECORD;
  return (
    <div
      role="img"
      aria-label={`${roomsOccupied} of ${roomsTotal} rooms occupied`}
      className={cn("grid gap-1.5", className)}
      style={{ gridTemplateColumns: "repeat(14, minmax(0, 1fr))" }}
    >
      {Array.from({ length: roomsTotal }, (_, i) => (
        <span
          key={i}
          className={cn(
            "aspect-square rounded-[5px] border",
            i < roomsOccupied ? "border-[#2f5fd0] bg-[#2f5fd0]" : "border-[#d6d7d2] bg-white",
          )}
        />
      ))}
    </div>
  );
}

/**
 * The proof strip: only numbers the captain has stated (`track-record.ts`). A
 * metric still waiting on a number is simply absent, never a placeholder.
 */
export function TrackRecordBand({ className, attr = "track-record" }: { className?: string; attr?: string }) {
  const metrics = trackRecordMetrics();
  return (
    <div className={cn("rounded-3xl border border-[#d6d7d2] bg-white/85 p-6 shadow-[0_18px_44px_-30px_rgba(12,13,16,0.3)] sm:p-8", className)} data-attr={attr}>
      <dl className="grid gap-6 sm:grid-cols-2 lg:grid-cols-[repeat(auto-fit,minmax(0,1fr))]">
        {metrics.map((m) => (
          <div key={m.id} className="flex flex-col">
            <dt className="order-2 mt-1.5 text-[13.5px] leading-snug text-muted">{m.label}</dt>
            <dd className="site-display order-1 text-[clamp(1.9rem,3.4vw,2.8rem)] font-bold leading-none tracking-[-0.035em] text-foreground">{m.value}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-7 border-t border-[#d6d7d2] pt-6">
        <OccupancyDots className="max-w-[26rem]" />
        <p className="mt-3 text-[13px] text-muted">
          {TRACK_RECORD.roomsOccupied} of {TRACK_RECORD.roomsTotal} rooms occupied across {TRACK_RECORD_HOMES.join(", ")}, Seattle.
        </p>
      </div>
    </div>
  );
}
