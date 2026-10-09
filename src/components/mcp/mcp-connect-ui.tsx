import Link from "next/link";
import type { ReactNode } from "react";
import { Plug, TriangleAlert } from "lucide-react";
import { AxisHeaderMarkTile, AxisLogoMark } from "@/components/brand/axis-logo";

/** Centered, phone-friendly shell shared by every MCP connection screen. */
export function McpConnectShell({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-[420px] flex-col justify-center px-4 py-10">
      <div className="w-full rounded-2xl border border-border bg-card p-6 shadow-sm">{children}</div>
    </main>
  );
}

/** PropLane mark and a generic app glyph joined by a short dotted connector. */
export function McpConnectHeader() {
  return (
    <div className="flex items-center justify-center gap-3" aria-hidden>
      <AxisLogoMark />
      <span className="w-8 border-t-2 border-dotted border-muted/60" />
      <AxisHeaderMarkTile>
        <Plug className="h-6 w-6" strokeWidth={1.75} />
      </AxisHeaderMarkTile>
    </div>
  );
}

/** Error state: icon, title, one line, and a way out. Never a dead end. */
export function McpConnectNotice({ title, line, actionHref = "/portal", actionLabel = "Open PropLane" }: { title: string; line: string; actionHref?: string; actionLabel?: string }) {
  return (
    <McpConnectShell>
      <div className="flex flex-col items-center text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-[18px] border border-danger/30 bg-danger/5 text-danger" aria-hidden>
          <TriangleAlert className="h-6 w-6" strokeWidth={1.75} />
        </div>
        <h1 className="mt-5 text-xl font-semibold tracking-tight text-foreground">{title}</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">{line}</p>
        <Link
          href={actionHref}
          data-attr="mcp-connect-notice-continue"
          className="mt-6 inline-flex min-h-[44px] w-full items-center justify-center rounded-full border border-primary/30 px-5 text-sm font-semibold text-primary outline-none transition-colors hover:bg-primary/5 focus-visible:ring-2 focus-visible:ring-primary/25 lg:min-h-8 lg:rounded-[var(--radius-control)]"
        >
          {actionLabel}
        </Link>
      </div>
    </McpConnectShell>
  );
}
