"use client";

/**
 * The homepage Software demo's iframe body (`/demo/home-embed`): the real resident, manager and vendor portals over
 * fixture data, a visible cursor that clicks their real controls, and a postMessage line to the parent page, which
 * draws the phone. The script is data (`home-demo-script.ts`); this file only plays it. Reduced motion
 * (`?static=1`) runs the same steps instantly with no cursor and stops on the journey's end state.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import "@/components/marketing/resident-lifecycle-engine.css";
import { DemoManagerShell } from "@/app/demo/demo-manager-shell";
import { preloadHomeDemoPanels } from "@/components/demo/demo-section-renderer";
import { installHomeDemoGuards } from "@/components/demo/home-demo-fetch-guard";
import { applyHomeDemoEffect, type HomeDemoEffectContext } from "@/components/demo/home-demo-effects";
import { HOME_DEMO_JOURNEY, homeDemoJumpPlan, type HomeDemoJumpPlan, type HomeDemoStep, type HomeDemoTarget } from "@/components/demo/home-demo-script";
import { DemoCursor, sleep, type DemoCursorApi } from "@/components/marketing/resident-lifecycle-cursor";
import { setDemoResidentIdentity, setDemoRole } from "@/lib/demo/demo-session";
import {
  HOME_DEMO_CONTROL,
  HOME_DEMO_EVENT,
  HOME_DEMO_INTERACT,
  HOME_DEMO_PORTAL_LABEL,
  HOME_DEMO_READY,
  isHomeDemoPortal,
  type HomeDemoControl,
  type HomeDemoEvent,
  type HomeDemoPortal,
} from "@/lib/demo/home-demo-embed";
import { HOME_DEMO_VENDOR_NAME } from "@/lib/demo/demo-guided-data";
import type { ResidentPortalNavStage } from "@/lib/resident-portal-nav";

class Cancelled extends Error {}

const TYPING_MS = 750;
/** Each real portal's address prefix: a `nav` target is the link into a section of whichever portal is on screen. */
const PORTAL_PREFIX: Record<HomeDemoPortal, string> = { manager: "/portal/", resident: "/resident/", vendor: "/vendor/" };

function isVisible(el: Element): boolean {
  const box = el.getBoundingClientRect();
  return box.width > 0 && box.height > 0;
}

/** Resolve a script target against the live portal. Nothing here knows the portal's markup beyond its routes and roles. */
function resolveTarget(target: HomeDemoTarget, portal: HomeDemoPortal): HTMLElement | null {
  if (target.kind === "nav") {
    const links = [...document.querySelectorAll<HTMLAnchorElement>(`a[href^="${PORTAL_PREFIX[portal]}${target.section}"]`)].filter(isVisible);
    return links.find((a) => a.closest("nav, aside")) ?? links[0] ?? null;
  }
  if (target.kind === "tab") {
    const label = target.label.toLowerCase();
    return [...document.querySelectorAll<HTMLElement>('[role="tab"], nav button, nav a')].find((el) => isVisible(el) && (el.textContent ?? "").trim().toLowerCase().startsWith(label)) ?? null;
  }
  if (target.kind === "button") {
    return [...document.querySelectorAll<HTMLElement>(`button[aria-label^="${target.label}"]`)].find(isVisible) ?? null;
  }
  if (target.kind === "css") return [...document.querySelectorAll<HTMLElement>(target.selector)].find(isVisible) ?? null;
  const text = target.text.toLowerCase();
  if (target.kind === "text") {
    return [...document.querySelectorAll<HTMLElement>("button, a[href], [role='button']")].find((el) => isVisible(el) && (el.textContent ?? "").toLowerCase().includes(text)) ?? null;
  }
  return [...document.querySelectorAll<HTMLElement>('button[data-attr$="-list-row"], [data-attr$="-list-row"] button, .portal-inbox-row button')].find((el) => isVisible(el) && (el.textContent ?? "").toLowerCase().includes(text)) ?? null;
}

/** When the section has no visible control (a navigation that folds it away), go there the way a link would. */
function navigateLikeALink(section: string, portal: HomeDemoPortal) {
  const host = document.getElementById("portal-main-content") ?? document.body;
  const anchor = document.createElement("a");
  anchor.setAttribute("href", `${PORTAL_PREFIX[portal]}${section}`);
  anchor.style.display = "none";
  host.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

/** A jump to the portal the journey opens in (outside reduced motion) is just a restart: nothing to replay. */
function toRunPlan(plan: HomeDemoJumpPlan, staticMode: boolean): HomeDemoJumpPlan | null {
  return staticMode || plan.resumeAt > 0 ? plan : null;
}

export function HomeDemoEmbed() {
  const cursorRef = useRef<DemoCursorApi>(null);
  const tokenRef = useRef(0);
  const pausedRef = useRef(false);
  const touchedRef = useRef(false);
  const staticRef = useRef(false);
  const skipToRef = useRef<string | null>(null);
  /** Set by the portal switcher: where the next run lands (read by `play`). */
  const planRef = useRef<HomeDemoJumpPlan | null>(null);
  /** Every panel the journey opens has loaded (the first run waits for it); a jump chosen before then is kept for it. */
  const panelsReadyRef = useRef(false);
  const pendingJumpRef = useRef<{ plan: HomeDemoJumpPlan } | null>(null);
  /** The real portal on screen, read by the steps (a `nav` target resolves against it). */
  const portalRef = useRef<HomeDemoPortal>(HOME_DEMO_JOURNEY.portal);
  const [portal, setPortal] = useState<HomeDemoPortal>(HOME_DEMO_JOURNEY.portal);
  const [switchTo, setSwitchTo] = useState<{ role: HomeDemoPortal; section: string; tab?: string } | null>(null);
  /** Where the resident is in the lifecycle: the resident sidebar is drawn (and unlocked) for this stage. */
  const [stage, setStage] = useState<ResidentPortalNavStage>(HOME_DEMO_JOURNEY.resident.stage);
  const [run, setRun] = useState(0);
  const [started, setStarted] = useState(false);
  const [instant, setInstant] = useState(false);
  /** A jump is catching the stores up to its portal: the screen is covered until that portal's first frame is drawn. */
  const [seeking, setSeeking] = useState(false);

  // Before any child effect runs: nothing in the sample portal may reach a server.
  useLayoutEffect(() => installHomeDemoGuards(), []);

  const post = useCallback((message: unknown) => {
    if (window.parent !== window) window.parent.postMessage(message, window.location.origin);
  }, []);

  const play = useCallback(
    async (token: number, staticMode: boolean, plan: HomeDemoJumpPlan | null) => {
      const journey = HOME_DEMO_JOURNEY;
      const ctx: HomeDemoEffectContext = { nowMs: Date.now() };
      const shown = journey.phones.map((phone) => phone.initial ?? 0);
      let phoneIndex = 0;
      // Reduced motion runs every step instantly; `?skipto=<mark>` does the same for the steps before that mark.
      // A jump (the portal switcher) replays what happened before its portal's first step as store writes only, then
      // plays that step and the rest with motion. In reduced motion it runs every step instantly up to the end of
      // that portal's part. Either way nothing is announced until it lands.
      let seekTo = plan && !staticMode && plan.resumeAt > 0 ? plan.resumeAt : null;
      const lastStep = plan && staticMode ? plan.until : journey.steps.length;
      let quiet = plan !== null;
      let noMotion = staticMode || skipToRef.current !== null || seekTo !== null;
      const guard = async () => {
        if (tokenRef.current !== token) throw new Cancelled();
        while (pausedRef.current && !noMotion) {
          await sleep(90);
          if (tokenRef.current !== token) throw new Cancelled();
        }
      };
      const wait = async (ms: number) => {
        if (noMotion) return;
        for (let spent = 0; spent < ms; spent += 60) {
          await guard();
          await sleep(Math.min(60, ms - spent));
        }
        await guard();
      };
      const announce = (step: number, typing: "in" | "out" | null, done: boolean) => {
        if (quiet) return;
        const phone = journey.phones[phoneIndex]!;
        const event: HomeDemoEvent = {
          type: HOME_DEMO_EVENT,
          step,
          done,
          typing,
          phone: { label: phone.label, items: phone.items.slice(0, shown[phoneIndex]) },
          portal: portalRef.current,
        };
        post(event);
      };
      // A click's effect lands at the press, just before the control opens, so a tab the effect fills never
      // shows its empty state first.
      const press = async (step: Extract<HomeDemoStep, { do: "click" | "hover" }>, onPress?: () => void) => {
        const deadline = Date.now() + (noMotion ? 2500 : 4000);
        let el = resolveTarget(step.target, portalRef.current);
        while (!el && Date.now() < deadline) {
          await sleep(100);
          await guard();
          el = resolveTarget(step.target, portalRef.current);
        }
        if (!el) {
          onPress?.();
          if (step.target.kind === "nav") navigateLikeALink(step.target.section, portalRef.current);
          return;
        }
        if (noMotion && step.do === "hover") el.scrollIntoView({ block: "center" });
        if (!noMotion) {
          const cursor = cursorRef.current;
          if (cursor) {
            await cursor.moveTo(el);
            await guard();
            if (step.do === "click") await cursor.press();
            cursor.clearHover();
          }
        }
        if (step.do === "hover") return;
        onPress?.();
        el.click();
        await sleep(noMotion ? 350 : 120);
      };

      try {
        await guard();
        announce(-1, null, false);
        for (let index = 0; index < lastStep; index += 1) {
          const step = journey.steps[index]!;
          await guard();
          if (seekTo !== null && index < seekTo) {
            // Before the portal the visitor chose: only what each step wrote, so its tabs are full when it opens.
            if (step.do === "say") {
              if (step.phone !== undefined && step.phone !== phoneIndex) phoneIndex = step.phone;
              shown[phoneIndex] = Math.min(journey.phones[phoneIndex]!.items.length, shown[phoneIndex]! + (step.count ?? 1));
              if (step.effect) applyHomeDemoEffect(step.effect, ctx);
            } else if (step.do === "click") {
              if (step.effect) applyHomeDemoEffect(step.effect, ctx);
            } else if (step.do === "effect") {
              applyHomeDemoEffect(step.effect, ctx);
            } else if (step.do === "portal") {
              if (step.effect) applyHomeDemoEffect(step.effect, ctx);
            } else if (step.do === "stage") {
              setStage(step.stage);
            }
            continue;
          }
          if (step.do === "mark") {
            if (noMotion && !staticMode && skipToRef.current === step.id) {
              noMotion = false;
              skipToRef.current = null;
              await sleep(600);
            }
          } else if (step.do === "wait") {
            await wait(step.ms);
          } else if (step.do === "say") {
            if (step.phone !== undefined && step.phone !== phoneIndex) phoneIndex = step.phone;
            if (step.typing && !noMotion) {
              announce(index - 1, step.typing, false);
              await wait(TYPING_MS);
            }
            shown[phoneIndex] = Math.min(journey.phones[phoneIndex]!.items.length, shown[phoneIndex]! + (step.count ?? 1));
            if (step.effect) applyHomeDemoEffect(step.effect, ctx);
            announce(index, null, false);
            await wait(450);
          } else if (step.do === "click" || step.do === "hover") {
            const effect = step.do === "click" ? step.effect : undefined;
            await press(step, effect ? () => applyHomeDemoEffect(effect, ctx) : undefined);
          } else if (step.do === "stage") {
            setStage(step.stage);
          } else if (step.do === "portal") {
            // The same shell and stores, another real portal: nothing the script wrote is lost, and the section it
            // opens already has what it shows.
            if (step.effect) applyHomeDemoEffect(step.effect, ctx);
            portalRef.current = step.role;
            setPortal(step.role);
            setSwitchTo({ role: step.role, section: step.section, ...(step.tab ? { tab: step.tab } : {}) });
            // The parent's "<Portal> portal" caption changes with the screen, not a beat after it.
            announce(index, null, false);
            await sleep(noMotion ? 350 : 250);
          } else {
            applyHomeDemoEffect(step.effect, ctx);
          }
          if (seekTo !== null && index === seekTo) {
            // Landed: that portal's first step has drawn, so the cover comes off and the run goes on with motion.
            seekTo = null;
            quiet = false;
            noMotion = skipToRef.current !== null;
            setSeeking(false);
          }
          announce(index, null, false);
        }
        quiet = false;
        setSeeking(false);
        cursorRef.current?.hide();
        announce(lastStep - 1, null, lastStep === journey.steps.length);
      } catch (error) {
        if (!(error instanceof Cancelled)) throw error;
      }
    },
    [post],
  );

  /** Start the journey from its first frame: a fresh shell re-seeds the fixture world, then the script runs. */
  const start = useCallback((noMotion: boolean, plan: HomeDemoJumpPlan | null = null) => {
    tokenRef.current += 1;
    planRef.current = plan;
    setSeeking(plan !== null);
    // The journey opens in its own portal, as its own person, before the shell mounts.
    const journey = HOME_DEMO_JOURNEY;
    portalRef.current = journey.portal;
    setPortal(journey.portal);
    setSwitchTo(null);
    setStage(journey.resident.stage);
    setDemoRole(journey.portal);
    setDemoResidentIdentity({ email: journey.resident.email });
    touchedRef.current = false;
    setInstant(noMotion);
    setStarted(true);
    setRun((value) => value + 1);
  }, []);

  useEffect(() => {
    if (run === 0) return;
    void play(tokenRef.current, staticRef.current, planRef.current);
  }, [run, play]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    staticRef.current = params.get("static") === "1";
    skipToRef.current = params.get("skipto");
    // The parent starts the iframe held when the section is not on screen yet.
    pausedRef.current = params.get("paused") === "1";
    // Every panel the journey opens is loaded before the first frame, so none is ever drawn as "Loading…".
    let cancelled = false;
    void preloadHomeDemoPanels().then(() => {
      if (cancelled) return;
      panelsReadyRef.current = true;
      const pending = pendingJumpRef.current;
      pendingJumpRef.current = null;
      start(staticRef.current, pending ? toRunPlan(pending.plan, staticRef.current) : null);
    });

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== window.parent) return;
      const data = event.data as HomeDemoControl | undefined;
      if (!data || data.type !== HOME_DEMO_CONTROL) return;
      if (data.action === "pause") pausedRef.current = true;
      else if (data.action === "restart") {
        pausedRef.current = false;
        start(staticRef.current);
      } else if (data.action === "jump" && isHomeDemoPortal(data.portal)) {
        // The portal switcher: cancel this run and begin that portal's part (reduced motion: draw its end frame).
        pausedRef.current = Boolean(data.paused);
        const plan = homeDemoJumpPlan(data.portal);
        // Chosen before the panels have loaded: the first run starts there instead (a second would restart it).
        if (!panelsReadyRef.current) pendingJumpRef.current = { plan };
        else start(staticRef.current, toRunPlan(plan, staticRef.current));
      } else if (data.action === "play") {
        pausedRef.current = false;
        // A visitor who used the portal by hand has left the script's track: start the journey over.
        if (touchedRef.current) start(staticRef.current);
      }
    };
    const onPointerDown = () => {
      touchedRef.current = true;
      post({ type: HOME_DEMO_INTERACT });
    };
    window.addEventListener("message", onMessage);
    window.addEventListener("pointerdown", onPointerDown, true);
    post({ type: HOME_DEMO_READY });
    return () => {
      cancelled = true;
      tokenRef.current += 1;
      window.removeEventListener("message", onMessage);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [start, post]);

  return (
    <div className="relative h-dvh overflow-hidden" data-home-demo-static={instant} data-home-demo-portal={portal}>
      {started ? (
        <DemoManagerShell
          key={`shell-${run}`}
          embed
          initialRole={HOME_DEMO_JOURNEY.portal}
          initialSection={HOME_DEMO_JOURNEY.section}
          switchTo={switchTo}
          residentProfile={{ ...HOME_DEMO_JOURNEY.resident, stage }}
          vendorName={HOME_DEMO_VENDOR_NAME}
        />
      ) : null}
      {seeking ? (
        <div className="absolute inset-0 grid place-items-center bg-white text-sm text-[#626b76]" style={{ zIndex: 2147483000 }} role="status">
          Loading sample…
        </div>
      ) : null}
      {started && !instant ? <DemoCursor key={`cursor-${run}`} label={HOME_DEMO_PORTAL_LABEL[portal]} apiRef={cursorRef} /> : null}
    </div>
  );
}
