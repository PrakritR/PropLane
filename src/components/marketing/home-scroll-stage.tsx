"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

type Visibility = { active: boolean; enhanced: boolean; near: boolean };
const StageVisibility = createContext<Visibility>({
  active: true,
  enhanced: false,
  near: false,
});
export const useHomeStageVisibility = () => useContext(StageVisibility);
type StageStep = {
  id: string;
  label: string;
  caption?: string;
  content: ReactNode;
};

/** Native scrolling owns progress. Without JS or with reduced motion, every scene is a normal section. */
export function HomeScrollStage({
  id,
  title,
  steps,
  className = "",
  travel,
  layout = "split",
}: {
  id: string;
  title: ReactNode;
  steps: StageStep[];
  className?: string;
  travel?: number;
  layout?: "split" | "wide";
}) {
  const root = useRef<HTMLElement>(null);
  const markers = useRef<(HTMLDivElement | null)[]>([]);
  const [enhanced, setEnhanced] = useState(false);
  const [active, setActive] = useState(0);
  const [near, setNear] = useState(false);
  useEffect(() => {
    if (!window.IntersectionObserver || !root.current) return;
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setEnhanced(!motion.matches);
    update();
    motion.addEventListener("change", update);
    const proximity = new IntersectionObserver(
      ([entry]) => {
        setNear(entry.isIntersecting);
      },
      { rootMargin: "150px" },
    );
    proximity.observe(root.current);
    return () => {
      motion.removeEventListener("change", update);
      proximity.disconnect();
    };
  }, []);
  useEffect(() => {
    if (!enhanced) return;
    let observer: IntersectionObserver;
    const updateActive = () => {
      const midpoint = window.innerHeight / 2;
      let closest = 0;
      let distance = Infinity;
      markers.current.forEach((marker, index) => {
        if (!marker) return;
        const rect = marker.getBoundingClientRect();
        const nextDistance = Math.max(
          rect.top - midpoint,
          midpoint - rect.bottom,
          0,
        );
        if (nextDistance < distance) {
          closest = index;
          distance = nextDistance;
        }
      });
      setActive(closest);
    };
    const observe = () => {
      observer?.disconnect();
      // Percentage root margins can resolve against width. Pixels keep this
      // activation band at the viewport's vertical midpoint in every aspect ratio.
      const inset = Math.max(0, Math.floor(window.innerHeight / 2) - 1);
      observer = new IntersectionObserver(updateActive, {
        rootMargin: `-${inset}px 0px -${inset}px 0px`,
        threshold: 0,
      });
      markers.current.forEach((marker) => {
        if (marker) observer.observe(marker);
      });
      updateActive();
    };
    observe();
    window.addEventListener("resize", observe);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", observe);
    };
  }, [enhanced, steps.length]);
  const labels = steps.filter(
    (step, index) => index === 0 || step.label !== steps[index - 1].label,
  );
  return (
    <section
      ref={root}
      id={id}
      className={`home-scroll-stage home-scroll-${layout} ${className}`}
      data-enhanced={enhanced}
      aria-labelledby={`${id}-title`}
      style={
        {
          "--stage-travel": `${travel ?? steps.length * 75}svh`,
          "--stage-count": steps.length,
        } as CSSProperties
      }
    >
      <div className="home-stage-sticky">
        <div className="home-stage-heading">
          <h2 id={`${id}-title`}>{title}</h2>
          <nav
            className="home-stage-rail"
            aria-label={`${id === "how" ? "Texting" : "Dashboard"} story sections`}
          >
            {labels.map((step) => (
              <a
                key={step.id}
                href={`#${id}-${step.id}`}
                aria-current={
                  steps[active]?.label === step.label ? "step" : undefined
                }
                onClick={(event) => {
                  if (
                    !enhanced ||
                    event.defaultPrevented ||
                    event.button !== 0 ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  )
                    return;
                  event.preventDefault();
                  const index = steps.indexOf(step);
                  const marker = markers.current[index];
                  if (marker)
                    window.scrollTo({
                      top:
                        window.scrollY +
                        marker.getBoundingClientRect().top -
                        window.innerHeight * 0.48,
                      behavior: "smooth",
                    });
                }}
              >
                {step.label}
              </a>
            ))}
          </nav>
          {enhanced && (
            <div className="home-stage-progress" aria-hidden="true">
              <span>
                {String(active + 1).padStart(2, "0")} /{" "}
                {String(steps.length).padStart(2, "0")}
              </span>
              <i>
                <b
                  style={{
                    transform: `scaleX(${(active + 1) / steps.length})`,
                  }}
                />
              </i>
            </div>
          )}
        </div>
        <div className="home-stage-scenes">
          {steps.map((step, index) => (
            <StageVisibility.Provider
              key={step.id}
              value={{ active: !enhanced || active === index, enhanced, near }}
            >
              <div
                className="home-stage-scene"
                id={enhanced ? undefined : `${id}-${step.id}`}
                data-active={!enhanced || active === index}
                aria-hidden={enhanced && active !== index ? true : undefined}
                inert={enhanced && active !== index ? true : undefined}
              >
                <div className="home-stage-content">{step.content}</div>
                {step.caption && (
                  <p className="home-stage-caption">{step.caption}</p>
                )}
              </div>
            </StageVisibility.Provider>
          ))}
        </div>
      </div>
      {enhanced && (
        <div className="home-stage-markers" aria-hidden="true">
          {steps.map((step, index) => (
            <div
              key={step.id}
              id={`${id}-${step.id}`}
              data-step={index}
              ref={(element) => {
                markers.current[index] = element;
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}
