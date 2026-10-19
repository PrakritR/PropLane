"use client";

/**
 * The homepage Software demo's iframe body (`/demo/home-embed`): the real manager portal over fixture data, a
 * visible cursor that clicks its real controls, and a postMessage line to the parent page, which draws the phone.
 * The script is data (`home-demo-script.ts`); this file only plays it. Reduced motion (`?static=1`) runs the same
 * steps instantly with no cursor and stops on the chapter's end state.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import "@/components/marketing/resident-lifecycle-engine.css";
import { DemoManagerShell } from "@/app/demo/demo-manager-shell";
import { installHomeDemoGuards } from "@/components/demo/home-demo-fetch-guard";
import { applyHomeDemoEffect, type HomeDemoEffectContext } from "@/components/demo/home-demo-effects";
import { HOME_DEMO_CHAPTER_DATA, type HomeDemoStep, type HomeDemoTarget } from "@/components/demo/home-demo-script";
import { DemoCursor, sleep, type DemoCursorApi } from "@/components/marketing/resident-lifecycle-cursor";
import {
  HOME_DEMO_CONTROL,
  HOME_DEMO_EVENT,
  HOME_DEMO_INTERACT,
  HOME_DEMO_READY,
  isHomeDemoChapterId,
  type HomeDemoChapterId,
  type HomeDemoControl,
  type HomeDemoEvent,
} from "@/lib/demo/home-demo-embed";

class Cancelled extends Error {}

const TYPING_MS = 750;
const PORTAL_PREFIX = "/portal/";

function isVisible(el: Element): boolean {
  const box = el.getBoundingClientRect();
  return box.width > 0 && box.height > 0;
}

/** Resolve a script target against the live portal. Nothing here knows the portal's markup beyond its routes and roles. */
function resolveTarget(target: HomeDemoTarget): HTMLElement | null {
  if (target.kind === "nav") {
    const links = [...document.querySelectorAll<HTMLAnchorElement>(`a[href^="${PORTAL_PREFIX}${target.section}"]`)].filter(isVisible);
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
function navigateLikeALink(section: string) {
  const host = document.getElementById("portal-main-content") ?? document.body;
  const anchor = document.createElement("a");
  anchor.setAttribute("href", `${PORTAL_PREFIX}${section}`);
  anchor.style.display = "none";
  host.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

export function HomeDemoEmbed() {
  const cursorRef = useRef<DemoCursorApi>(null);
  const tokenRef = useRef(0);
  const pausedRef = useRef(false);
  const touchedRef = useRef(false);
  const staticRef = useRef(false);
  const chapterRef = useRef<HomeDemoChapterId>("find");
  const [run, setRun] = useState(0);
  const [started, setStarted] = useState(false);
  const [instant, setInstant] = useState(false);

  // Before any child effect runs: nothing in the sample portal may reach a server.
  useLayoutEffect(() => installHomeDemoGuards(), []);

  const post = useCallback((message: unknown) => {
    if (window.parent !== window) window.parent.postMessage(message, window.location.origin);
  }, []);

  const play = useCallback(
    async (chapterId: HomeDemoChapterId, token: number, noMotion: boolean) => {
      const chapter = HOME_DEMO_CHAPTER_DATA[chapterId];
      const ctx: HomeDemoEffectContext = { nowMs: Date.now() };
      const shown = chapter.phones.map(() => 0);
      let phoneIndex = 0;
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
        const phone = chapter.phones[phoneIndex]!;
        const event: HomeDemoEvent = {
          type: HOME_DEMO_EVENT,
          chapter: chapterId,
          step,
          done,
          typing,
          phone: { label: phone.label, items: phone.items.slice(0, shown[phoneIndex]) },
        };
        post(event);
      };
      // A click's effect lands at the press, just before the control opens, so a tab the effect fills never
      // shows its empty state first.
      const press = async (step: Extract<HomeDemoStep, { do: "click" | "hover" }>, onPress?: () => void) => {
        const deadline = Date.now() + (noMotion ? 2500 : 4000);
        let el = resolveTarget(step.target);
        while (!el && Date.now() < deadline) {
          await sleep(100);
          await guard();
          el = resolveTarget(step.target);
        }
        if (!el) {
          onPress?.();
          if (step.target.kind === "nav") navigateLikeALink(step.target.section);
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
        for (const effect of chapter.prepare ?? []) applyHomeDemoEffect(effect, ctx);
        announce(-1, null, false);
        for (let index = 0; index < chapter.steps.length; index += 1) {
          const step = chapter.steps[index]!;
          await guard();
          if (step.do === "wait") {
            await wait(step.ms);
          } else if (step.do === "say") {
            if (step.phone !== undefined && step.phone !== phoneIndex) phoneIndex = step.phone;
            if (step.typing && !noMotion) {
              announce(index - 1, step.typing, false);
              await wait(TYPING_MS);
            }
            shown[phoneIndex] = Math.min(chapter.phones[phoneIndex]!.items.length, shown[phoneIndex]! + (step.count ?? 1));
            if (step.effect) applyHomeDemoEffect(step.effect, ctx);
            announce(index, null, false);
            await wait(450);
          } else if (step.do === "click" || step.do === "hover") {
            const effect = step.do === "click" ? step.effect : undefined;
            await press(step, effect ? () => applyHomeDemoEffect(effect, ctx) : undefined);
          } else {
            applyHomeDemoEffect(step.effect, ctx);
          }
          announce(index, null, false);
        }
        cursorRef.current?.hide();
        announce(chapter.steps.length - 1, null, true);
      } catch (error) {
        if (!(error instanceof Cancelled)) throw error;
      }
    },
    [post],
  );

  /** Start a chapter from its first frame: a fresh shell re-seeds the fixture world, then the script runs. */
  const select = useCallback((chapter: HomeDemoChapterId, noMotion: boolean) => {
    tokenRef.current += 1;
    chapterRef.current = chapter;
    touchedRef.current = false;
    setInstant(noMotion);
    setStarted(true);
    setRun((value) => value + 1);
  }, []);

  useEffect(() => {
    if (run === 0) return;
    void play(chapterRef.current, tokenRef.current, staticRef.current);
  }, [run, play]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const chapter = params.get("chapter");
    staticRef.current = params.get("static") === "1";
    // The parent starts the iframe held when the section is not on screen yet.
    pausedRef.current = params.get("paused") === "1";
    select(isHomeDemoChapterId(chapter) ? chapter : "find", staticRef.current);

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin || event.source !== window.parent) return;
      const data = event.data as HomeDemoControl | undefined;
      if (!data || data.type !== HOME_DEMO_CONTROL) return;
      if (data.action === "pause") pausedRef.current = true;
      else if (data.action === "play") {
        pausedRef.current = false;
        // A visitor who used the portal by hand has left the script's track: start the chapter over.
        if (touchedRef.current) select(chapterRef.current, staticRef.current);
      } else if (data.action === "select" && isHomeDemoChapterId(data.chapter)) {
        pausedRef.current = false;
        select(data.chapter, staticRef.current);
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
      tokenRef.current += 1;
      window.removeEventListener("message", onMessage);
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [select, post]);

  return (
    <div className="relative h-dvh overflow-hidden" data-home-demo-static={instant}>
      {started ? <DemoManagerShell key={`shell-${run}`} embed /> : null}
      {started && !instant ? <DemoCursor key={`cursor-${run}`} label="Manager" apiRef={cursorRef} /> : null}
    </div>
  );
}
