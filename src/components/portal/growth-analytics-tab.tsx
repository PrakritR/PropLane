"use client";

import { growthApi } from "@/lib/growth/client";
import { GROWTH_PLATFORMS } from "@/lib/growth/types";
import { GrowthErrorBanner, GrowthSkeletonBlocks, PLATFORM_SHORT, useGrowthLoad } from "@/components/portal/growth-shared";

function fmt(n: number | null | undefined): string {
  return n == null ? "—" : n.toLocaleString("en-US");
}

export function GrowthAnalyticsTab() {
  const { data, error, loading, reload } = useGrowthLoad(() => growthApi.analytics());
  if (loading) return <GrowthSkeletonBlocks count={3} />;
  if (error || !data) return <GrowthErrorBanner message={error ?? "Could not load analytics."} onRetry={reload} dataAttr="admin-growth-analytics-error" />;

  const empty = data.posts.length === 0 && data.learned.length === 0 && !data.totals.postsPublished30d;
  const tiles = [
    { label: "Followers, all platforms", value: fmt(data.totals.followers), attr: "followers" },
    { label: "Views, last 7 days", value: fmt(data.totals.views7d), attr: "views" },
    { label: "Posts published, 30 days", value: fmt(data.totals.postsPublished30d), attr: "published" },
    { label: "Link clicks", value: fmt(data.totals.linkClicks), attr: "clicks" },
  ];

  return (
    <div className="space-y-5" data-attr="admin-growth-analytics">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.attr} className="rounded-2xl border border-border bg-accent/30 px-4 py-3" data-attr={`admin-growth-tile-${t.attr}`}>
            <p className="text-2xl font-bold tabular-nums tracking-tight text-foreground">{t.value}</p>
            <p className="mt-1 text-xs font-medium text-muted">{t.label}</p>
          </div>
        ))}
      </div>
      {empty ? (
        <div className="rounded-2xl border border-dashed border-border bg-accent/25 px-6 py-10 text-center" data-attr="admin-growth-analytics-empty">
          <p className="text-sm font-semibold text-foreground">Nothing published yet.</p>
          <p className="mt-1 text-xs text-muted">Numbers and learned lines appear here after the first posts go out.</p>
        </div>
      ) : (
        <>
          <div className="overflow-x-auto rounded-2xl border border-border bg-card" data-attr="admin-growth-analytics-table">
            <table className="w-full min-w-[32rem] text-left text-xs">
              <thead className="border-b border-border text-muted">
                <tr>
                  <th className="px-3 py-2 font-semibold">Post</th>
                  {GROWTH_PLATFORMS.map((p) => (
                    <th key={p} className="px-2 py-2 font-semibold">{PLATFORM_SHORT[p]}</th>
                  ))}
                  <th className="px-3 py-2 font-semibold">Learned</th>
                </tr>
              </thead>
              <tbody>
                {data.posts.map((row) => (
                  <tr key={row.postId} className="border-b border-border/70 last:border-0" data-attr="admin-growth-analytics-row">
                    <td className="px-3 py-2 font-medium text-foreground">{row.title}</td>
                    {GROWTH_PLATFORMS.map((p) => (
                      <td key={p} className="px-2 py-2 tabular-nums text-muted">{fmt(row.views[p])}</td>
                    ))}
                    <td className="px-3 py-2 text-muted">{row.learned ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <section data-attr="admin-growth-learned">
            <h3 className="mb-2 text-sm font-semibold text-foreground">What the engine learned</h3>
            {data.learned.length === 0 ? (
              <p className="text-xs text-muted">No clear signal yet.</p>
            ) : (
              <ul className="space-y-1.5">
                {data.learned.map((l) => (
                  <li key={l.id} className="rounded-xl border border-border bg-card px-3 py-2 text-sm text-foreground" data-attr="admin-growth-learned-line">
                    {l.line}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}
