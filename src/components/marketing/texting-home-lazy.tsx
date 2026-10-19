"use client";
import dynamic from "next/dynamic";
import { useEffect, useRef, useState } from "react";
const Draft = dynamic(() => import("./texting-home-proof"), { ssr: false });
const Dashboard = dynamic(
  () =>
    import("./site/product-mock/dashboards").then(
      (m) => m.ManagerDashboardView,
    ),
  { ssr: false },
);

/** Portal modules load near their proof, never on phones for the dashboard. */
export function TextingHomeLazy({ kind }: { kind: "draft" | "dashboard" }) {
  const ref = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (
          entry?.isIntersecting &&
          (kind === "draft" || window.matchMedia("(min-width: 640px)").matches)
        ) {
          setReady(true);
          observer.disconnect();
        }
      },
      { rootMargin: "150px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [kind]);
  return (
    <div ref={ref} className={`texting-lazy-${kind}`}>
      {ready ? (
        kind === "draft" ? (
          <Draft />
        ) : (
          <Dashboard scrollWithinWindow={false} />
        )
      ) : (
        <div
          className="texting-proof-placeholder"
          role="status"
          aria-label={`Loading ${kind === "draft" ? "sample draft" : "manager dashboard"}`}
        />
      )}
    </div>
  );
}
