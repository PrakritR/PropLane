"use client";

/**
 * The home page hero and the guided demo beneath it (captain 2026-10-06).
 *
 * The hero is Akhil's. The demo plays his guided sample (a prospect's message
 * through tour, application, lease and move-in) and extends it into a demo
 * "through the platform": a Manager, Resident and Vendor portal switcher, a
 * tab per stage with a progress bar that fills while the stage plays, autoplay
 * at about three seconds a step, and every sidebar item opening the real panel
 * for that tab (`DemoPanel`, `site/product-mock/demo-panels.tsx`).
 *
 * Everything on screen is derived from one number, the beat, and the script in
 * `resident-lifecycle-script.ts`, so a stage tab can jump anywhere without
 * replaying. Nothing here touches the network or saves: it is a sample.
 *
 * Autoplay pauses while the pointer or focus is inside the stage, while the
 * demo is off screen, once a visitor starts exploring (any sidebar click), and
 * never runs under prefers-reduced-motion. Without autoplay the highlighted
 * button is the guide: clicking it plays that step, exactly as before.
 */

import "./resident-lifecycle-prototypes.css";
import "./resident-lifecycle-engine.css";
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { ArrowRight, Check, RotateCcw } from "lucide-react";
import Link from "next/link";
import { AppStoreBadge } from "@/components/marketing/app-store-badge";
import { BOOK_DEMO_HREF, GET_STARTED_HREF } from "@/lib/marketing/public-contact";
import { DEMO_TABS, DemoPanel, type DemoPortal } from "@/components/marketing/site/product-mock/demo-panels";
import { ManagerActionStrip, ManagerCommunication } from "./resident-lifecycle-manager";
import { ResidentLifecyclePhone } from "./resident-lifecycle-phone";
import { ResidentLifecycleAtmosphere } from "./resident-lifecycle-atmosphere";
import { ResidentLifecycleWorkspace } from "./resident-lifecycle-workspace";
import {
  MANAGER_DONE_BEAT,
  MANAGER_STEPS,
  PORTAL_META,
  PORTAL_ORDER,
  SUGGESTED_REPLY,
  TRACKS,
  firstBeatOfChapter,
  managerScript,
  phoneScriptFor,
  type Chapter,
  type SampleMessage,
} from "./resident-lifecycle-script";

/** One beat is about three seconds: a guided step clicks itself at CLICK_AT, then plays ~930ms. */
const BEAT_MS = 3000;
const CLICK_AT_MS = 1700;
const WALKTHROUGH = "#resident-lifecycle-walkthrough";

const isNarrow = () => window.matchMedia("(max-width: 850px)").matches;
const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Arrow keys, Home and End move focus along a tablist; Enter and Space activate the focused tab. */
function tablistKeys(event: KeyboardEvent<HTMLElement>) {
  const keys = ["ArrowRight", "ArrowLeft", "Home", "End"];
  if (!keys.includes(event.key)) return;
  const tabs = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]'));
  const at = tabs.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  event.preventDefault();
  const next =
    event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (at + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  tabs[next]?.focus();
}

export function ResidentLifecyclePrototypes() {
  const [portal, setPortal] = useState<DemoPortal>("manager");
  const [beat, setBeat] = useState(0);
  /** The guided step whose effect is already showing while its chapter transition plays. */
  const [pending, setPending] = useState<number | null>(null);
  const [extra, setExtra] = useState<SampleMessage[]>([]);
  const [sentReply, setSentReply] = useState(SUGGESTED_REPLY);
  const [tabOverride, setTabOverride] = useState<string | null>(null);
  const [exploring, setExploring] = useState(false);
  const [busy, setBusy] = useState(false);
  const [activity, setActivity] = useState<string[]>([]);
  const [viewVersion, setViewVersion] = useState(0);
  const [jumpVersion, setJumpVersion] = useState(0);
  const [guideEntered, setGuideEntered] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [inView, setInView] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const busyRef = useRef(false);
  const elapsed = useRef(0);
  const sectionRef = useRef<HTMLElement>(null);
  const stageTabsRef = useRef<HTMLDivElement>(null);
  const latest = useRef<{ tick(dt: number): void }>({ tick: () => {} });

  const meta = PORTAL_META[portal];
  const track = TRACKS[portal];
  const current = track.beats[beat]!;
  const stage = track.stages[current.stage]!;
  const statePhase = pending !== null ? Math.max(beat, pending + 1) : beat;
  const script = portal === "manager" ? managerScript(beat, statePhase, sentReply) : null;
  const activeStep = portal === "manager" ? current.step : undefined;
  const activeTab = tabOverride ?? current.tab;
  const playing = !reduced && !exploring && !hovered && !focused && inView;
  const guideTarget = exploring || busy ? undefined : activeStep?.target;
  const guideInstruction = exploring || busy ? undefined : activeStep?.instruction;
  const finished = portal === "manager" && beat >= MANAGER_DONE_BEAT;

  useEffect(() => () => timers.current.forEach(clearTimeout), []);
  useEffect(() => {
    const query = window.matchMedia("(prefers-reduced-motion: reduce)");
    const sync = () => setReduced(query.matches);
    sync();
    query.addEventListener("change", sync);
    return () => query.removeEventListener("change", sync);
  }, []);
  useEffect(() => {
    const section = sectionRef.current;
    if (!section || typeof IntersectionObserver === "undefined") {
      setInView(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => setInView(Boolean(entry?.isIntersecting)), { threshold: 0.1 });
    observer.observe(section);
    return () => observer.disconnect();
  }, []);
  // On a phone, bring the highlighted button into view when a visitor is stepping through by hand.
  useEffect(() => {
    if (!activeStep || exploring || busy || playing || !guideEntered || !isNarrow()) return;
    document.querySelector<HTMLElement>(`[data-guide-target="${activeStep.target}"]`)?.scrollIntoView({
      behavior: prefersReducedMotion() ? "instant" : "smooth",
      block: "center",
    });
  }, [beat, viewVersion, jumpVersion, exploring, busy, playing, activeStep, guideEntered]);
  // Keep the playing stage visible in the phone-width tab strip.
  useEffect(() => {
    const strip = stageTabsRef.current;
    const tab = strip?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!strip || !tab || strip.scrollWidth <= strip.clientWidth) return;
    strip.scrollTo({ left: tab.offsetLeft - 16, behavior: prefersReducedMotion() ? "auto" : "smooth" });
  }, [stage.id, portal]);

  const later = (fn: () => void, ms: number) => {
    timers.current.push(setTimeout(fn, ms));
  };
  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    busyRef.current = false;
    setBusy(false);
  };
  const goToBeat = (next: number, quiet = false) => {
    elapsed.current = 0;
    setBeat(next);
    setPending(null);
    setTabOverride(null);
    const caption = track.beats[next]?.step ? null : track.beats[next]?.caption;
    if (!quiet && caption) setActivity((items) => [...items.slice(-2), caption]);
  };
  const resetStory = (nextPortal: DemoPortal) => {
    clearTimers();
    elapsed.current = 0;
    setPortal(nextPortal);
    setBeat(0);
    setPending(null);
    setExtra([]);
    setSentReply(SUGGESTED_REPLY);
    setTabOverride(null);
    setExploring(false);
    setActivity([]);
    setViewVersion((value) => value + 1);
  };
  const replay = () => resetStory(portal);
  const restartGuide = () => {
    replay();
    setGuideEntered(true);
  };
  const jumpToStage = (index: number) => {
    clearTimers();
    setExploring(false);
    setGuideEntered(true);
    setJumpVersion((value) => value + 1);
    goToBeat(track.stages[index]!.first);
  };
  const selectTab = (tab: string) => {
    setTabOverride(tab);
    setExploring(true);
  };

  /** Take a guided step (or any step ahead of the current one: it implies the ones before it). */
  const act = (target: string): boolean => {
    if (busyRef.current) return false;
    const index = MANAGER_STEPS.findIndex((step) => step.target === target);
    if (index < 0 || index < beat) return true;
    const step = MANAGER_STEPS[index]!;
    busyRef.current = true;
    setBusy(true);
    setGuideEntered(true);
    setPending(index);
    setActivity((items) => [...items.slice(-2), step.activity[0]]);
    later(() => {
      setActivity((items) => [...items.slice(-2), step.activity[1]]);
      later(() => {
        busyRef.current = false;
        setBusy(false);
        goToBeat(index + 1, true);
      }, 410);
    }, 520);
    return true;
  };
  const managerReply = (text: string): boolean => {
    if (busyRef.current) return false;
    if (beat === 1) {
      setSentReply(text);
      return act("send");
    }
    setExtra((items) => [...items, { from: "manager", text, stage: (script?.chapter ?? "message") as Chapter }]);
    return true;
  };
  const phoneReply = (text: string): boolean => {
    setExtra((items) => [...items, { from: "resident", text, stage: (script?.chapter ?? "message") as Chapter }]);
    return true;
  };

  // Autoplay: one frame loop that only runs while `playing`; elapsed time survives a pause.
  const tick = (dt: number) => {
    elapsed.current += dt;
    const spent = elapsed.current;
    const bar = stageTabsRef.current?.querySelector<HTMLElement>('[data-state="active"]');
    bar?.style.setProperty("--p", String(Math.min(1, (beat - stage.first + Math.min(spent / BEAT_MS, 0.97)) / stage.count)));
    if (activeStep) {
      if (busyRef.current || spent < CLICK_AT_MS) return;
      const target = document.querySelector<HTMLButtonElement>(`${WALKTHROUGH} [data-guide-target="${activeStep.target}"]`);
      if (target && !target.disabled) target.click();
      else if (spent >= CLICK_AT_MS + 1200) act(activeStep.target);
    } else if (spent >= BEAT_MS) {
      if (beat + 1 >= track.beats.length) {
        if (portal === "manager") replay();
        else goToBeat(0);
      } else goToBeat(beat + 1);
    }
  };
  useEffect(() => {
    latest.current.tick = tick;
  });
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    let last = performance.now();
    const loop = (now: number) => {
      const dt = Math.min(now - last, 100);
      last = now;
      latest.current.tick(dt);
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const messages = [...(script?.messages ?? []), ...extra];
  const repairStage = TRACKS.manager.stages.findIndex((item) => item.id === "repair");
  const isCommunication = portal === "manager" && activeTab === "communication";
  const guideText = exploring ? "Explore the sample at your pace" : busy ? activity.at(-1) : (activeStep?.instruction ?? current.caption);
  const stageTabId = (id: string) => `demo-stage-${portal}-${id}`;

  return (
    <div className="rlp-page">
      <section className="rlp-hero" aria-labelledby="rlp-hero-title">
        <ResidentLifecycleAtmosphere />
        <div className="rlp-hero-copy">
          <h1 id="rlp-hero-title">
            From first question
            <br />
            to feeling at home.
          </h1>
          <div className="rlp-hero-actions">
            <Link href={GET_STARTED_HREF} data-attr="home-hero-get-started">
              Start free - no card
            </Link>
            <Link href={BOOK_DEMO_HREF} data-attr="home-hero-book-demo">
              Book a demo
            </Link>
            <AppStoreBadge tone="dark" size="lg" dataAttr="home-hero-app-store" className="rlp-app-store" />
          </div>
          <a
            href={WALKTHROUGH}
            className="rlp-follow-story"
            data-attr="resident-lifecycle-explore"
            onClick={(event) => {
              setGuideEntered(true);
              if (isNarrow()) {
                event.preventDefault();
                window.history.replaceState(null, "", WALKTHROUGH);
                sectionRef.current?.scrollIntoView({ behavior: prefersReducedMotion() ? "instant" : "smooth", block: "start" });
              }
            }}
          >
            Follow the story <ArrowRight aria-hidden />
          </a>
        </div>
      </section>
      <section id="resident-lifecycle-walkthrough" ref={sectionRef} className="rlp-walkthrough" aria-labelledby="rlp-walkthrough-title">
        <div className="rlp-walkthrough-heading">
          <h2 id="rlp-walkthrough-title">One conversation. Every next step.</h2>
        </div>
        <div className="rlp-demo-controls">
          <div className="rlp-portal-switch" role="tablist" aria-label="Portal" onKeyDown={tablistKeys}>
            {PORTAL_ORDER.map((id) => (
              <button
                type="button"
                role="tab"
                key={id}
                id={`demo-portal-${id}`}
                aria-selected={portal === id}
                tabIndex={portal === id ? 0 : -1}
                className="rlp-portal-tab"
                data-attr={`home-demo-portal-${id}`}
                onClick={() => portal !== id && resetStory(id)}
              >
                {PORTAL_META[id].label}
              </button>
            ))}
          </div>
          <div
            ref={stageTabsRef}
            className="rlp-stage-tabs"
            role="tablist"
            aria-label={`${meta.label} stages`}
            style={{ "--stages": track.stages.length } as CSSProperties}
            onKeyDown={tablistKeys}
          >
            {track.stages.map((item, index) => {
              const selected = index === current.stage;
              return (
                <button
                  type="button"
                  role="tab"
                  key={item.id}
                  id={stageTabId(item.id)}
                  aria-selected={selected}
                  aria-controls="rlp-demo-stage"
                  tabIndex={selected ? 0 : -1}
                  className="rlp-stage-tab"
                  data-state={selected ? "active" : index < current.stage ? "done" : "todo"}
                  data-attr={`home-demo-stage-${item.id}`}
                  style={selected && reduced ? ({ "--p": 1 } as CSSProperties) : undefined}
                  onClick={() => jumpToStage(index)}
                >
                  <small>{index + 1}</small>
                  <span>{item.label}</span>
                  <i className="rlp-stage-bar" aria-hidden>
                    <b />
                  </i>
                </button>
              );
            })}
          </div>
        </div>
        <div className="rlp-guide-line" aria-live={playing ? "off" : "polite"}>
          <div className="rlp-guide-copy">
            <span className="rlp-sample-tag">Sample demo</span>
            <strong>
              {finished && !exploring && !busy ? <Check aria-hidden /> : null}
              {guideText}
            </strong>
          </div>
          <div className="rlp-guide-actions">
            {finished ? (
              <button type="button" onClick={replay}>
                <RotateCcw aria-hidden /> Replay
              </button>
            ) : exploring ? (
              <button type="button" onClick={restartGuide}>
                Restart guide
              </button>
            ) : (
              <button type="button" onClick={() => setExploring(true)}>
                Explore freely
              </button>
            )}
          </div>
        </div>
        <div className="rlp-dual-labels">
          <span>{meta.workspaceLabel}</span>
          <span>{meta.phoneCaption}</span>
        </div>
        <div
          id="rlp-demo-stage"
          role="tabpanel"
          aria-labelledby={stageTabId(stage.id)}
          className="rlp-dual-view"
          onPointerEnter={() => setHovered(true)}
          onPointerLeave={() => setHovered(false)}
          onFocus={() => setFocused(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
          }}
        >
          <ResidentLifecycleWorkspace
            portal={portal}
            tabs={DEMO_TABS[portal]}
            active={activeTab}
            badges={script && !script.applicationApproved ? { applications: 2 } : undefined}
            onSelect={selectTab}
            panel={!isCommunication}
          >
            {isCommunication && script ? (
              <ManagerCommunication
                key={`comm-${viewVersion}-${jumpVersion}`}
                messages={messages}
                chapter={script.chapter}
                suggestedReply={script.suggestedReply}
                initialDraft={script.suggestedReply && statePhase < 2 ? SUGGESTED_REPLY : ""}
                busy={busy}
                guideTarget={guideTarget}
                guideInstruction={guideInstruction}
                onSuggest={() => act("suggest")}
                onReply={managerReply}
              />
            ) : (
              <>
                <div className="rlp-panel-frame" data-demo-panel={`${portal}:${activeTab}`}>
                  <DemoPanel key={`${portal}-${activeTab}`} portal={portal} tab={activeTab} />
                </div>
                {script ? (
                  <div className="rlp-panel-strip">
                    <ManagerActionStrip
                      tab={activeTab}
                      tourAccepted={script.tourAccepted}
                      applicationApproved={script.applicationApproved}
                      leaseStep={script.leaseStep}
                      serviceRecord={script.serviceRecord}
                      vendorOffered={current.stage >= repairStage}
                      guideTarget={guideTarget}
                      guideInstruction={guideInstruction}
                      busy={busy}
                      onApprove={() => act("approve")}
                      onSendLease={() => act("send-lease")}
                      onManagerSign={() => act("manager-sign")}
                      onChapter={(chapter) => goToBeat(Math.max(beat, firstBeatOfChapter(chapter)))}
                      onOpenTab={selectTab}
                    />
                  </div>
                ) : null}
              </>
            )}
          </ResidentLifecycleWorkspace>
          {script ? (
            <ResidentLifecyclePhone
              key={`phone-${script.chapter}-${viewVersion}-${jumpVersion}`}
              stage={script.chapter}
              tourAccepted={script.tourAccepted}
              applicationApproved={script.applicationApproved}
              leaseStep={script.leaseStep}
              serviceCreated={Boolean(script.serviceRecord)}
              messages={messages}
              busy={busy}
              guideTarget={guideTarget}
              guideInstruction={guideInstruction}
              onAcceptTour={() => act("accept-tour")}
              onOpenLease={() => act("open-lease")}
              onResidentSign={() => act("resident-sign")}
              onCreateService={() => act("service")}
              onReply={phoneReply}
            />
          ) : (
            <ResidentLifecyclePhone
              key={`phone-${portal}-${stage.id}-${viewVersion}-${jumpVersion}`}
              stage="message"
              tourAccepted={false}
              applicationApproved={false}
              leaseStep={0}
              serviceCreated={false}
              messages={[]}
              busy={false}
              script={phoneScriptFor(portal as Exclude<DemoPortal, "manager">, stage.id)}
              onAcceptTour={() => false}
              onOpenLease={() => false}
              onResidentSign={() => false}
              onCreateService={() => false}
              onReply={() => true}
            />
          )}
        </div>
        <div className="rlp-activity" aria-label="Sample activity" aria-live="off">
          <span className="rlp-activity-label">ACTIVITY</span>
          {activity.length ? (
            activity.map((item, index) => (
              <span key={`${item}-${index}`} className={index === activity.length - 1 ? "rlp-activity-current" : ""}>
                {item}
              </span>
            ))
          ) : (
            <span>{meta.opening}</span>
          )}
        </div>
      </section>
    </div>
  );
}
