"use client";

import { useMemo, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePortalNavigate } from "@/lib/portal-nav-client";
import { formatPacificDate, pacificCalendarDateYmd } from "@/lib/pacific-time";
import { growthApi } from "@/lib/growth/client";
import { cn } from "@/lib/utils";
import { FORMAT_CHIP, GrowthErrorBanner, GrowthSkeletonBlocks, useGrowthLoad } from "@/components/portal/growth-shared";

const DAY_MS = 86_400_000;

/** Monday (YYYY-MM-DD) of the week containing the given Pacific calendar date. */
function mondayOf(ymd: string): string {
  const d = new Date(`${ymd}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - dow * DAY_MS).toISOString().slice(0, 10);
}

function addDays(ymd: string, n: number): string {
  return new Date(new Date(`${ymd}T12:00:00Z`).getTime() + n * DAY_MS).toISOString().slice(0, 10);
}

export function GrowthCalendarTab() {
  const navigate = usePortalNavigate();
  const { data: posts, error, loading, reload } = useGrowthLoad(() => growthApi.listPosts());
  const [weekStart, setWeekStart] = useState(() => mondayOf(pacificCalendarDateYmd()));
  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(weekStart, i)), [weekStart]);

  const byDay = useMemo(() => {
    const map = new Map<string, NonNullable<typeof posts>>();
    for (const post of posts ?? []) {
      if (!post.scheduledFor || !["approved", "scheduled", "publishing", "published", "failed"].includes(post.status)) continue;
      const ymd = pacificCalendarDateYmd(Date.parse(post.scheduledFor));
      map.set(ymd, [...(map.get(ymd) ?? []), post].sort((a, b) => (a.scheduledFor ?? "").localeCompare(b.scheduledFor ?? "")));
    }
    return map;
  }, [posts]);

  const label = `${formatPacificDate(`${days[0]}T12:00:00Z`, { month: "short", day: "numeric" })} - ${formatPacificDate(`${days[6]}T12:00:00Z`, { month: "short", day: "numeric" })}`;

  return (
    <div className="space-y-3" data-attr="admin-growth-calendar">
      <div className="flex items-center gap-2">
        <Button type="button" variant="outline" className="h-9 w-9 p-0" aria-label="Previous week" data-attr="admin-growth-calendar-prev" onClick={() => setWeekStart(addDays(weekStart, -7))}>
          <ChevronLeft className="size-4" aria-hidden />
        </Button>
        <span className="min-w-[8rem] text-center text-sm font-semibold text-foreground" data-attr="admin-growth-calendar-range">
          {label}
        </span>
        <Button type="button" variant="outline" className="h-9 w-9 p-0" aria-label="Next week" data-attr="admin-growth-calendar-next" onClick={() => setWeekStart(addDays(weekStart, 7))}>
          <ChevronRight className="size-4" aria-hidden />
        </Button>
        <Button type="button" variant="ghost" className="h-9 px-3 text-xs" data-attr="admin-growth-calendar-today" onClick={() => setWeekStart(mondayOf(pacificCalendarDateYmd()))}>
          Today
        </Button>
      </div>
      {error ? <GrowthErrorBanner message={error} onRetry={reload} dataAttr="admin-growth-calendar-error" /> : null}
      {loading ? <GrowthSkeletonBlocks count={3} /> : null}
      {posts ? (
        <div className="grid grid-cols-1 gap-2 md:grid-cols-7" data-attr="admin-growth-week">
          {days.map((ymd) => {
            const items = byDay.get(ymd) ?? [];
            return (
              <div key={ymd} className="min-w-0 rounded-2xl border border-border bg-card p-2" data-attr="admin-growth-day">
                <h4 className="mb-2 text-xs font-bold text-muted">{formatPacificDate(`${ymd}T12:00:00Z`, { weekday: "short", month: "short", day: "numeric" })}</h4>
                <div className="space-y-1">
                  {items.length === 0 ? <p className="text-[11px] text-muted/70">Nothing scheduled</p> : null}
                  {items.map((post) => (
                    <button
                      key={post.id}
                      type="button"
                      data-attr="admin-growth-calendar-chip"
                      data-status={post.status}
                      onClick={() => navigate(`/admin/growth/post/${encodeURIComponent(post.id)}`)}
                      className={cn(
                        "w-full rounded-lg border px-2 py-1 text-left text-[11px] font-medium leading-tight",
                        FORMAT_CHIP[post.format],
                        post.status === "published" && "opacity-55",
                      )}
                    >
                      {formatPacificDate(post.scheduledFor!, { hour: "numeric", minute: "2-digit" })} · {post.title}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
