"use client";

/**
 * The home page hero and the guided demo beneath it (captain 2026-10-06, revised
 * 2026-10-07).
 *
 * The hero is the two-line headline and three buttons, with the demo itself in the
 * same first screen directly under them. The demo plays Akhil's guided sample (a
 * prospect's message through tour, application, lease and move-in), extended into
 * a demo "through the platform" across the Manager, Resident and Vendor portals.
 * There is no stage UI on screen: the story drives the window and the phone by
 * itself (`resident-lifecycle-script.ts`), and the visitor changes portal from the
 * window's own account menu, exactly as a multi-role user does in the real portal.
 * Every sidebar item opens the real panel for that tab (`DemoPanel`,
 * `site/product-mock/demo-panels.tsx`); clicking one stops the autoplay.
 *
 * Everything on screen is derived from one number, the beat, so nothing replays
 * from scratch. Nothing here touches the network or saves: it is a sample.
 *
 * Autoplay pauses while the pointer or focus is inside the window, while the account
 * menu is open, while the demo is off screen, once a visitor starts exploring (any
 * sidebar click), and never runs under prefers-reduced-motion. The window also
 * grows from about 88% to full size as the page scrolls through the first 60% of
 * the viewport (transform only, so nothing shifts; off under reduced motion).
 */

import "./resident-lifecycle-prototypes.css";
import "./resident-lifecycle-engine.css";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AppStoreBadge } from "@/components/marketing/app-store-badge";
import { BOOK_DEMO_HREF, GET_STARTED_HREF } from "@/lib/marketing/public-contact";
import { DEMO_TABS, DemoPanel, type DemoPortal } from "@/components/marketing/site/product-mock/demo-panels";
import { managerStory, residentStory, vendorStory, worldFor, type DemoStory } from "@/components/marketing/site/product-mock/world";
import { ManagerActionStrip, ManagerCommunication } from "./resident-lifecycle-manager";
import { ResidentLifecyclePhone } from "./resident-lifecycle-phone";
import { ResidentLifecycleWorkspace } from "./resident-lifecycle-workspace";
import {
  COMMUNICATION_THREADS,
  MANAGER_STEPS,
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

/** The hero window starts at GROW_FROM of its size and reaches full size after GROW_OVER of the viewport height. */
const GROW_FROM = 0.88;
const GROW_OVER = 0.6;

export function ResidentLifecyclePrototypes() {
  const [portal, setPortal] = useState<DemoPortal>("manager");
  const [beat, setBeat] = useState(0);
  /** The guided step whose effect is already showing while its chapter transition plays. */
  const [pending, setPending] = useState<number | null>(null);
  const [extra, setExtra] = useState<SampleMessage[]>([]);
  const [sentReply, setSentReply] = useState(SUGGESTED_REPLY);
  const [tabOverride, setTabOverride] = useState<string | null>(null);
  /** The first three seconds show the manager's Dashboard before the story starts. */
  const [intro, setIntro] = useState(true);
  const [exploring, setExploring] = useState(false);
  const [busy, setBusy] = useState(false);
  const [viewVersion, setViewVersion] = useState(0);
  const [guideEntered, setGuideEntered] = useState(false);
  const [reduced, setReduced] = useState(false);
  const [inView, setInView] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [focused, setFocused] = useState(false);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const busyRef = useRef(false);
  const elapsed = useRef(0);
  const sectionRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const latest = useRef<{ tick(dt: number): void }>({ tick: () => {} });

  const track = TRACKS[portal];
  const current = track.beats[beat]!;
  const stage = track.stages[current.stage]!;
  const statePhase = pending !== null ? Math.max(beat, pending + 1) : beat;
  const script = portal === "manager" ? managerScript(beat, statePhase, sentReply) : null;
  const activeStep = portal === "manager" ? current.step : undefined;
  const introShowing = intro && portal === "manager" && beat === 0;
  const activeTab = tabOverride ?? (introShowing ? "dashboard" : current.tab);
  const story: DemoStory =
    portal === "manager" && script
      ? managerStory({
          tourOffered: script.tourOffered,
          tourAccepted: script.tourAccepted,
          applicationSubmitted: script.applicationSubmitted,
          applicationApproved: script.applicationApproved,
          leaseStep: script.leaseStep,
          rentPaid: script.rentPaid,
          vendorBooked: script.vendorBooked,
          hasServiceRecord: Boolean(script.serviceRecord),
        })
      : portal === "resident"
        ? residentStory(stage.id)
        : vendorStory(stage.id);
  const sidebarBadges = portal === "manager" ? { ...worldFor(story).badges, communication: COMMUNICATION_THREADS.length } : undefined;
  const playing = !reduced && !exploring && !hovered && !focused && !menuOpen && inView;
  const guideTarget = exploring || busy || introShowing ? undefined : activeStep?.target;
  const guideInstruction = exploring || busy || introShowing ? undefined : activeStep?.instruction;

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
  }, [beat, viewVersion, exploring, busy, playing, activeStep, guideEntered]);
  // Scroll growth: the window grows from GROW_FROM to full size over the first GROW_OVER of the viewport.
  useEffect(() => {
    const stageEl = stageRef.current;
    if (!stageEl || reduced) return;
    let frame = 0;
    const apply = () => {
      frame = 0;
      const progress = Math.min(1, Math.max(0, window.scrollY / (window.innerHeight * GROW_OVER)));
      stageEl.style.setProperty("--rlp-grow", String(GROW_FROM + (1 - GROW_FROM) * progress));
    };
    const onScroll = () => {
      if (!frame) frame = requestAnimationFrame(apply);
    };
    apply();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [reduced]);

  const later = (fn: () => void, ms: number) => {
    timers.current.push(setTimeout(fn, ms));
  };
  const clearTimers = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    busyRef.current = false;
    setBusy(false);
  };
  const goToBeat = (next: number) => {
    elapsed.current = 0;
    setBeat(next);
    setPending(null);
    setTabOverride(null);
  };
  const resetStory = (nextPortal: DemoPortal) => {
    clearTimers();
    elapsed.current = 0;
    setIntro(nextPortal === "manager" && nextPortal !== portal);
    setPortal(nextPortal);
    setBeat(0);
    setPending(null);
    setExtra([]);
    setSentReply(SUGGESTED_REPLY);
    setTabOverride(null);
    setExploring(false);
    setViewVersion((value) => value + 1);
  };
  const replay = () => resetStory(portal);
  const selectTab = (tab: string) => {
    setTabOverride(tab);
    setExploring(true);
    setIntro(false);
  };
  const startStory = () => {
    elapsed.current = 0;
    setIntro(false);
  };

  /** Take a guided step (or any step ahead of the current one: it implies the ones before it). */
  const act = (target: string): boolean => {
    if (busyRef.current) return false;
    const index = MANAGER_STEPS.findIndex((step) => step.target === target);
    if (index < 0 || index < beat) return true;
    busyRef.current = true;
    setBusy(true);
    setGuideEntered(true);
    setPending(index);
    later(() => {
      later(() => {
        busyRef.current = false;
        setBusy(false);
        goToBeat(index + 1);
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
    if (introShowing) {
      if (spent >= BEAT_MS) startStory();
      return;
    }
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
  return (
    <div className="rlp-page">
      <section
        id="resident-lifecycle-walkthrough"
        ref={sectionRef}
        className="rlp-hero"
        aria-labelledby="rlp-hero-title"
      >
        <div className="rlp-hero-copy">
          <h1 id="rlp-hero-title">
            <span className="rlp-h1-line">Your AI property</span>{" "}
            <br />
            <span className="rlp-h1-line">management assistant.</span>
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
        </div>
        <div className="rlp-hero-stage" ref={stageRef}>
          <div
            id="rlp-demo-stage"
            role="group"
            aria-label="Sample PropLane workspace"
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
              badges={sidebarBadges}
              onSelect={selectTab}
              onSwitchPortal={resetStory}
              onMenuOpenChange={setMenuOpen}
              panel={!isCommunication}
            >
              {isCommunication && script ? (
                <ManagerCommunication
                  key={`comm-${viewVersion}`}
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
                    <DemoPanel key={`${portal}-${activeTab}`} portal={portal} tab={activeTab} story={story} stage={stage.id} />
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
                key={`phone-${script.chapter}-${viewVersion}`}
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
                key={`phone-${portal}-${stage.id}-${viewVersion}`}
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
        </div>
      </section>
    </div>
  );
}
